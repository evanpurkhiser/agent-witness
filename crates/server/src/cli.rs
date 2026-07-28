use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
};

use anyhow::bail;
use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    config::{Config, ConfigOverrides},
    control, daemon,
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
    init_tracing()?;

    let cli = Cli::parse();
    match cli.command {
        Command::Serve(args) => serve(cli.config, cli.control_socket, args).await,
        Command::Pairing {
            command: PairingCommand::Clear(args),
        } => clear_pairing(cli.config, cli.control_socket, args).await,
    }
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

    daemon::run(config).await
}

async fn clear_pairing(
    config_path: Option<PathBuf>,
    control_socket: Option<PathBuf>,
    args: ClearPairingArgs,
) -> anyhow::Result<()> {
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

fn init_tracing() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("agent_witness_server=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init()
        .map_err(|error| anyhow::anyhow!("could not initialize logging: {error}"))
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{ClearPairingArgs, Cli, Command, PairingCommand};

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
