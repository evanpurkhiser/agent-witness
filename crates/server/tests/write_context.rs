use std::process::Command;

use agent_witness_server::{packet::RequestContext, request_router::context};

#[test]
fn writes_only_the_framed_packet_without_executing_argv() {
    let output = Command::new(env!("CARGO_BIN_EXE_agent-witness"))
        .args([
            "write-context",
            "--reason",
            "Push the release",
            "--groupId",
            "d371fa50-458a-4191-8893-d00139c781a2",
            "--",
            "not-an-executable",
            "--flag",
            "two words",
            "",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let expected = context::encode(&RequestContext {
        group_id: "d371fa50-458a-4191-8893-d00139c781a2".parse().unwrap(),
        reason: "Push the release".into(),
        command: vec![
            "not-an-executable".into(),
            "--flag".into(),
            "two words".into(),
            "".into(),
        ],
    })
    .unwrap();
    assert_eq!(output.stdout, expected);
}

#[test]
fn invalid_context_reports_errors_without_writing_a_partial_packet() {
    for args in [
        vec!["write-context", "--reason", "Push\nrelease", "--", "git"],
        vec![
            "write-context",
            "--reason",
            "Push",
            "--groupId",
            "invalid",
            "--",
            "git",
        ],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_agent-witness"))
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.is_empty());
    }
}
