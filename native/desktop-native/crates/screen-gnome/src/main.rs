mod accessibility;
mod actions;
mod bus;
mod capture;
mod desktop;
mod eis;
mod error;
mod ibus;
mod input;
mod observation;
mod portal;
mod power;
mod protocol;
mod text;
mod toolkit;

#[tokio::main(flavor = "current_thread")]
async fn main() -> std::io::Result<()> {
    tokio::task::LocalSet::new()
        .run_until(protocol::run(
            tokio::io::BufReader::new(tokio::io::stdin()),
            tokio::io::stdout(),
        ))
        .await
}
