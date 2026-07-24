use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use figment::{
    Figment,
    providers::{Format, Serialized, Toml},
};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

const DEFAULT_UNIX_SOCKET: &str = "/run/agent-witness/agent.sock";

/// Operator-controlled daemon configuration.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Path exposed to local processes as `SSH_AUTH_SOCK`.
    pub unix_socket: PathBuf,

    /// Unix permission bits applied to the SSH-agent socket.
    #[serde(deserialize_with = "deserialize_mode")]
    pub socket_mode: u32,

    /// Maximum time a local request may wait for completion.
    #[serde(with = "humantime_serde")]
    pub request_timeout: Duration,

    /// Maximum SSH-agent payload size accepted from a local connection.
    pub max_agent_packet_size: usize,

    /// Maximum number of queued and in-flight local requests.
    pub max_pending_requests: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            unix_socket: PathBuf::from(DEFAULT_UNIX_SOCKET),
            socket_mode: 0o600,
            request_timeout: Duration::from_secs(90),
            max_agent_packet_size: 256 * 1024,
            max_pending_requests: 32,
        }
    }
}

/// CLI values layered over the defaults and optional configuration file.
#[derive(Default)]
pub struct ConfigOverrides {
    /// Explicit SSH-agent socket path supplied on the command line.
    pub unix_socket: Option<PathBuf>,

    /// Explicit request timeout supplied on the command line.
    pub request_timeout: Option<Duration>,
}

impl Config {
    /// Load defaults, then an optional TOML file, then explicit CLI overrides.
    pub fn extract(
        path: Option<&Path>,
        overrides: ConfigOverrides,
    ) -> Result<Self, Box<figment::Error>> {
        let mut figment = Figment::from(Serialized::defaults(Self::default()));

        if let Some(path) = path {
            figment = figment.merge(Toml::file(path));
        }
        if let Some(unix_socket) = overrides.unix_socket {
            figment = figment.merge(Serialized::default("unix_socket", unix_socket));
        }
        if let Some(request_timeout) = overrides.request_timeout {
            figment = figment.merge(Serialized::default(
                "request_timeout",
                humantime::format_duration(request_timeout).to_string(),
            ));
        }

        figment.extract().map_err(Box::new)
    }

    /// Reject values that cannot be represented safely by the runtime.
    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.socket_mode & !0o777 != 0 {
            return Err(ConfigError::Invalid(
                "socket_mode must contain only Unix permission bits".into(),
            ));
        }

        if self.request_timeout.is_zero() {
            return Err(ConfigError::Invalid(
                "request_timeout must be greater than zero".into(),
            ));
        }

        if self.max_agent_packet_size == 0 {
            return Err(ConfigError::Invalid(
                "max_agent_packet_size must be greater than zero".into(),
            ));
        }
        if self.max_agent_packet_size > u32::MAX as usize {
            return Err(ConfigError::Invalid(
                "max_agent_packet_size cannot exceed the SSH-agent u32 frame length".into(),
            ));
        }

        if self.max_pending_requests == 0 {
            return Err(ConfigError::Invalid(
                "max_pending_requests must be greater than zero".into(),
            ));
        }

        Ok(())
    }
}

/// Failure to validate an extracted configuration.
#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid configuration: {0}")]
    Invalid(String),
}

fn deserialize_mode<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    struct ModeVisitor;

    impl serde::de::Visitor<'_> for ModeVisitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an octal permission string or integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            value.try_into().map_err(E::custom)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            u32::from_str_radix(value, 8).map_err(E::custom)
        }
    }

    deserializer.deserialize_any(ModeVisitor)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, time::Duration};

    use tempfile::tempdir;

    use super::{Config, ConfigOverrides};

    #[test]
    fn layers_a_partial_file_over_defaults() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.toml");
        fs::write(
            &path,
            r#"
                unix_socket = "/tmp/agent-witness.sock"
                socket_mode = "0660"
                request_timeout = "15s"
            "#,
        )
        .unwrap();

        let config = Config::extract(Some(&path), ConfigOverrides::default()).unwrap();

        assert_eq!(config.unix_socket, PathBuf::from("/tmp/agent-witness.sock"));
        assert_eq!(config.socket_mode, 0o660);
        assert_eq!(config.request_timeout, Duration::from_secs(15));
        assert_eq!(config.max_agent_packet_size, 256 * 1024);
        assert_eq!(config.max_pending_requests, 32);
    }

    #[test]
    fn cli_values_override_the_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.toml");
        fs::write(&path, "request_timeout = \"15s\"").unwrap();

        let config = Config::extract(
            Some(&path),
            ConfigOverrides {
                request_timeout: Some(Duration::from_secs(2)),
                ..ConfigOverrides::default()
            },
        )
        .unwrap();

        assert_eq!(config.request_timeout, Duration::from_secs(2));
    }

    #[test]
    fn rejects_unknown_fields() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.toml");
        fs::write(&path, "unknown = true").unwrap();

        let result = Config::extract(Some(&path), ConfigOverrides::default());

        assert!(result.is_err());
    }

    #[test]
    fn rejects_invalid_values() {
        let config = Config {
            max_pending_requests: 0,
            ..Config::default()
        };

        assert!(config.validate().is_err());
    }
}
