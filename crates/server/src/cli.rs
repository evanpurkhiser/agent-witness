use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    config::{Config, ConfigOverrides},
    daemon,
};

#[derive(Debug, Parser)]
#[command(name = "agent-witness", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the agent-witness daemon.
    Serve(ServeArgs),
}

#[derive(Debug, Args)]
struct ServeArgs {
    /// Read daemon configuration from this TOML file.
    #[arg(long)]
    config: Option<PathBuf>,

    /// Override the configured SSH-agent socket path.
    #[arg(long)]
    unix_socket: Option<PathBuf>,

    /// Override how long a local request may wait for completion.
    #[arg(long)]
    request_timeout: Option<humantime::Duration>,
}

pub async fn run() -> anyhow::Result<()> {
    init_tracing()?;

    match Cli::parse().command {
        Command::Serve(args) => serve(args).await,
    }
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let config = Config::extract(
        args.config.as_deref(),
        ConfigOverrides {
            unix_socket: args.unix_socket,
            request_timeout: args.request_timeout.map(Into::into),
        },
    )?;
    config.validate()?;

    daemon::run(config).await
}

fn init_tracing() -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("agent_witness_server=info"));

    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init()
        .map_err(|error| anyhow::anyhow!("could not initialize logging: {error}"))
}
