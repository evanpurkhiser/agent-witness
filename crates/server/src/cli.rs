use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
};

use anyhow::{Context, bail};
use clap::{Args, Parser, Subcommand};
use sentry::integrations::tracing::{EventFilter, default_event_filter};
use tracing_subscriber::{EnvFilter, prelude::*};

use crate::{
    config::{Config, ConfigOverrides},
    control, daemon,
    packet::RequestContext,
    request_router::context,
};

#[derive(Debug, Parser)]
#[command(name = "agent-witness", version, about)]
struct Cli {
    /// Read configuration from this TOML file.
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    /// Override the configured administrative control socket path.
    #[arg(long, global = true)]
    control_socket: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the agent-witness daemon.
    Serve(ServeArgs),

    /// Write an SSH-agent request context packet to stdout.
    ///
    /// Outputs one binary, length-prefixed context@agent-witness extension packet
    /// for a wrapper to prepend to an SSH-agent connection. The command after --
    /// is included as metadata and is not executed.
    #[command(
        after_help = "Example:\n  agent-witness write-context --reason \"Push the release\" --groupId d371fa50458a41918893d00139c781a2 -- git push origin main"
    )]
    WriteContext(WriteContextArgs),

    /// Manage the paired remote client.
    Pairing {
        #[command(subcommand)]
        command: PairingCommand,
    },
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// Override the configured SSH-agent socket path.
    #[arg(long)]
    unix_socket: Option<PathBuf>,

    /// Override how long a local request may wait for completion.
    #[arg(long)]
    request_timeout: Option<humantime::Duration>,
}

#[derive(Debug, Args)]
struct WriteContextArgs {
    /// Required explanation shown with authentication requests (1–512 UTF-8 bytes, single line).
    #[arg(long, value_name = "TEXT")]
    reason: String,

    /// UUID shared by related requests; defaults to a new UUID.
    #[arg(long = "groupId", value_name = "ID")]
    group_id: Option<uuid::Uuid>,

    /// Required command and arguments after --, sent as metadata without execution.
    ///
    /// Preserves argument boundaries. Accepts up to 128 arguments totaling
    /// 16 KiB of UTF-8 text.
    #[arg(last = true, required = true, num_args = 1..)]
    argv: Vec<String>,
}

#[derive(Debug, Subcommand)]
enum PairingCommand {
    /// Clear the paired client and revoke its active session.
    Clear(ClearPairingArgs),
}

#[derive(Debug, Args)]
struct ClearPairingArgs {
    /// Clear pairing without an interactive confirmation.
    #[arg(long)]
    yes: bool,
}

pub async fn run() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => serve(cli.config, cli.control_socket, args).await,
        Command::WriteContext(args) => write_context(args),
        Command::Pairing {
            command: PairingCommand::Clear(args),
        } => clear_pairing(cli.config, cli.control_socket, args).await,
    }
}

fn write_context(args: WriteContextArgs) -> anyhow::Result<()> {
    let context = RequestContext {
        group_id: args.group_id.unwrap_or_else(uuid::Uuid::new_v4),
        reason: args.reason,
        command: args.argv,
    };
    let packet = context::encode(&context)?;
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&packet)
        .context("could not write request context")?;
    stdout.flush().context("could not flush request context")
}

async fn serve(
    config_path: Option<PathBuf>,
    control_socket: Option<PathBuf>,
    args: ServeArgs,
) -> anyhow::Result<()> {
    let config = Config::extract(
        config_path.as_deref(),
        ConfigOverrides {
            control_socket,
            unix_socket: args.unix_socket,
            request_timeout: args.request_timeout.map(Into::into),
        },
    )?;
    config.validate()?;

    let _sentry = init_tracing(config.sentry_backend_dsn.as_deref())?;

    daemon::run(config).await
}

async fn clear_pairing(
    config_path: Option<PathBuf>,
    control_socket: Option<PathBuf>,
    args: ClearPairingArgs,
) -> anyhow::Result<()> {
    let _sentry = init_tracing(None)?;

    if !args.yes {
        confirm_clear()?;
    }

    let config = Config::extract(
        config_path.as_deref(),
        ConfigOverrides {
            control_socket,
            ..ConfigOverrides::default()
        },
    )?;
    let had_client = control::clear_pairing(&config.control_socket).await?;

    if had_client {
        println!("Pairing cleared.");
    } else {
        println!("No client was paired.");
    }

    Ok(())
}

fn confirm_clear() -> anyhow::Result<()> {
    if !io::stdin().is_terminal() {
        bail!("refusing to clear pairing without confirmation; pass --yes");
    }

    eprint!("Clear the paired client and disconnect its active session? [y/N] ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        bail!("pairing was not cleared");
    }

    Ok(())
}

fn init_tracing(sentry_dsn: Option<&str>) -> anyhow::Result<Option<sentry::ClientInitGuard>> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("agent_witness_server=info"));

    let sentry = sentry_dsn.map(|dsn| {
        let options = sentry::ClientOptions::new()
            .dsn(dsn)
            .enable_logs(true)
            .maybe_release(sentry::release_name!())
            .traces_sample_rate(1.0);

        sentry::init(options)
    });
    let sentry_layer = sentry.as_ref().map(|_| {
        sentry::integrations::tracing::layer()
            .event_filter(|metadata| default_event_filter(metadata) | EventFilter::Log)
    });

    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(sentry_layer)
        .try_init()
        .map_err(|error| anyhow::anyhow!("could not initialize logging: {error}"))?;

    Ok(sentry)
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{ClearPairingArgs, Cli, Command, PairingCommand};

    #[test]
    fn parses_context_metadata_without_consuming_command_flags() {
        let cli = Cli::try_parse_from([
            "agent-witness",
            "write-context",
            "--reason",
            "Push the release",
            "--groupId",
            "d371fa50-458a-4191-8893-d00139c781a2",
            "--",
            "git",
            "push",
            "--all",
            "release candidate",
            "",
        ])
        .unwrap();
        let Command::WriteContext(args) = cli.command else {
            panic!("expected write-context")
        };
        assert_eq!(args.reason, "Push the release");
        assert_eq!(
            args.group_id,
            Some("d371fa50-458a-4191-8893-d00139c781a2".parse().unwrap())
        );
        assert_eq!(args.argv, ["git", "push", "--all", "release candidate", ""]);
    }

    #[test]
    fn rejects_non_uuid_context_group_ids() {
        assert!(
            Cli::try_parse_from([
                "agent-witness",
                "write-context",
                "--reason",
                "Push",
                "--groupId",
                "release-123",
                "--",
                "git",
            ])
            .is_err()
        );
    }

    #[test]
    fn context_requires_reason_and_command_but_allows_default_group() {
        assert!(Cli::try_parse_from(["agent-witness", "write-context", "--", "git"]).is_err());
        assert!(
            Cli::try_parse_from(["agent-witness", "write-context", "--reason", "Push"]).is_err()
        );
        let cli = Cli::try_parse_from([
            "agent-witness",
            "write-context",
            "--reason",
            "Push",
            "--",
            "git",
        ])
        .unwrap();
        let Command::WriteContext(args) = cli.command else {
            panic!("expected write-context")
        };
        assert!(args.group_id.is_none());
    }

    #[test]
    fn parses_non_interactive_pairing_clear() {
        let cli = Cli::try_parse_from([
            "agent-witness",
            "pairing",
            "clear",
            "--yes",
            "--control-socket",
            "/tmp/control.sock",
        ])
        .unwrap();

        assert_eq!(
            cli.control_socket.unwrap(),
            std::path::PathBuf::from("/tmp/control.sock")
        );
        assert!(matches!(
            cli.command,
            Command::Pairing {
                command: PairingCommand::Clear(ClearPairingArgs { yes: true })
            }
        ));
    }
}
