#[tokio::main]
async fn main() -> anyhow::Result<()> {
    agent_witness_server::cli::run().await
}
