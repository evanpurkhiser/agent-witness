use bytes::Bytes;
use thiserror::Error;

use crate::packet::RequestContext;

const CONTEXT_EXTENSION: &[u8] = b"context@agent-witness";
const CONTEXT_VERSION: u8 = 1;
const SSH_AGENTC_EXTENSION: u8 = 27;

const MAX_REASON_SIZE: usize = 512;
const MAX_COMMAND_ARGUMENTS: usize = 128;
const MAX_COMMAND_SIZE: usize = 16 * 1024;

/// Decode an Agent Witness context extension, leaving other agent packets untouched.
pub(super) fn decode(packet: &Bytes) -> Result<Option<RequestContext>, ContextError> {
    let Some(mut decoder) = Decoder::packet(packet) else {
        return Ok(None);
    };
    if decoder.take_u8()? != SSH_AGENTC_EXTENSION {
        return Ok(None);
    }

    let name = decoder.take_string()?;
    if name != CONTEXT_EXTENSION {
        return Ok(None);
    }
    if decoder.take_u8()? != CONTEXT_VERSION {
        return Err(ContextError::UnsupportedVersion);
    }

    let group_id = std::str::from_utf8(decoder.take_string()?)
        .ok()
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .ok_or(ContextError::InvalidGroupId)?;
    let reason =
        decode_text(decoder.take_string()?, MAX_REASON_SIZE).ok_or(ContextError::InvalidReason)?;
    let argument_count = decoder.take_u32()? as usize;
    if !(1..=MAX_COMMAND_ARGUMENTS).contains(&argument_count) {
        return Err(ContextError::InvalidCommand);
    }

    let mut command = Vec::with_capacity(argument_count);
    let mut command_size = 0;
    for _ in 0..argument_count {
        let argument = decoder.take_string()?;
        command_size += argument.len();
        if command_size > MAX_COMMAND_SIZE {
            return Err(ContextError::InvalidCommand);
        }
        command.push(String::from_utf8_lossy(argument).into_owned());
    }
    decoder.finish()?;

    Ok(Some(RequestContext {
        group_id,
        reason,
        command,
    }))
}

fn decode_text(value: &[u8], max_size: usize) -> Option<String> {
    if value.is_empty() || value.len() > max_size {
        return None;
    }

    let value = std::str::from_utf8(value).ok()?;
    value
        .chars()
        .all(|character| {
            character == ' ' || (!character.is_control() && !character.is_whitespace())
        })
        .then(|| value.to_owned())
}

struct Decoder<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> Decoder<'a> {
    fn packet(packet: &'a [u8]) -> Option<Self> {
        let length = u32::from_be_bytes(packet.get(..4)?.try_into().ok()?) as usize;
        let data = packet.get(4..)?;

        (data.len() == length).then_some(Self { data, offset: 0 })
    }

    fn take(&mut self, size: usize) -> Result<&'a [u8], ContextError> {
        let end = self
            .offset
            .checked_add(size)
            .ok_or(ContextError::Malformed)?;
        let value = self
            .data
            .get(self.offset..end)
            .ok_or(ContextError::Malformed)?;
        self.offset = end;

        Ok(value)
    }

    fn take_u8(&mut self) -> Result<u8, ContextError> {
        Ok(self.take(1)?[0])
    }

    fn take_u32(&mut self) -> Result<u32, ContextError> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().expect("four bytes requested"),
        ))
    }

    fn take_string(&mut self) -> Result<&'a [u8], ContextError> {
        let length = self.take_u32()? as usize;
        self.take(length)
    }

    fn finish(self) -> Result<(), ContextError> {
        if self.offset != self.data.len() {
            return Err(ContextError::Malformed);
        }

        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub(crate) enum ContextError {
    #[error("malformed Agent Witness context extension")]
    Malformed,

    #[error("unsupported Agent Witness context version")]
    UnsupportedVersion,

    #[error("invalid Agent Witness context group ID")]
    InvalidGroupId,

    #[error("invalid Agent Witness context reason")]
    InvalidReason,

    #[error("invalid Agent Witness context command")]
    InvalidCommand,
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use crate::packet::RequestContext;

    use super::{CONTEXT_EXTENSION, ContextError, decode};

    #[test]
    fn decodes_a_context_extension() {
        let packet = context_packet(
            "d371fa50-458a-4191-8893-d00139c781a2",
            "Push the release",
            &["git", "push"],
        );

        assert_eq!(
            decode(&packet),
            Ok(Some(RequestContext {
                group_id: "d371fa50-458a-4191-8893-d00139c781a2".parse().unwrap(),
                reason: "Push the release".into(),
                command: vec!["git".into(), "push".into()],
            }))
        );
    }

    #[test]
    fn ignores_other_agent_packets_and_extensions() {
        assert_eq!(decode(&Bytes::from_static(&[0, 0, 0, 1, 11])), Ok(None));
        assert_eq!(
            decode(&extension_packet("query@openssh.com", b"")),
            Ok(None)
        );
    }

    #[test]
    fn rejects_non_uuid_group_ids() {
        for group_id in ["release-123", "", "d371fa50-458a-4191-8893-d00139c781az"] {
            assert_eq!(
                decode(&context_packet(group_id, "Push", &["git"])),
                Err(ContextError::InvalidGroupId)
            );
        }
    }

    #[test]
    fn rejects_invalid_context_contents() {
        let mut unsupported =
            context_packet("d371fa50-458a-4191-8893-d00139c781a2", "Push", &["git"]).to_vec();
        let version_offset = 4 + 1 + 4 + CONTEXT_EXTENSION.len();
        unsupported[version_offset] = 2;
        assert_eq!(
            decode(&unsupported.into()),
            Err(ContextError::UnsupportedVersion)
        );

        assert_eq!(
            decode(&context_packet("", "Push", &["git"])),
            Err(ContextError::InvalidGroupId)
        );
        assert_eq!(
            decode(&context_packet(
                "d371fa50-458a-4191-8893-d00139c781a2",
                "Push\nrelease",
                &["git"]
            )),
            Err(ContextError::InvalidReason)
        );
        assert_eq!(
            decode(&context_packet(
                "d371fa50-458a-4191-8893-d00139c781a2",
                "Push",
                &[]
            )),
            Err(ContextError::InvalidCommand)
        );
    }

    #[test]
    fn rejects_truncated_and_trailing_context_data() {
        let packet = context_packet("d371fa50-458a-4191-8893-d00139c781a2", "Push", &["git"]);
        assert_eq!(
            decode(&packet.slice(..packet.len() - 1)),
            Ok(None),
            "an incomplete outer frame is not classified as this extension"
        );

        let mut packet = packet.to_vec();
        packet.push(0);
        let length = (packet.len() - 4) as u32;
        packet[..4].copy_from_slice(&length.to_be_bytes());
        assert_eq!(decode(&packet.into()), Err(ContextError::Malformed));
    }

    fn context_packet(group_id: &str, reason: &str, command: &[&str]) -> Bytes {
        let mut contents = vec![1];
        push_string(&mut contents, group_id.as_bytes());
        push_string(&mut contents, reason.as_bytes());
        contents.extend_from_slice(&(command.len() as u32).to_be_bytes());
        for argument in command {
            push_string(&mut contents, argument.as_bytes());
        }

        extension_packet(std::str::from_utf8(CONTEXT_EXTENSION).unwrap(), &contents)
    }

    fn extension_packet(name: &str, contents: &[u8]) -> Bytes {
        let payload_length = 1 + 4 + name.len() + contents.len();
        let mut packet = Vec::with_capacity(payload_length + 4);
        packet.extend_from_slice(&(payload_length as u32).to_be_bytes());
        packet.push(27);
        push_string(&mut packet, name.as_bytes());
        packet.extend_from_slice(contents);
        packet.into()
    }

    fn push_string(packet: &mut Vec<u8>, value: &[u8]) {
        packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
        packet.extend_from_slice(value);
    }
}
