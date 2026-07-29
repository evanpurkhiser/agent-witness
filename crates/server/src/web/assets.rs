use std::{borrow::Cow, fmt::Write};

use axum::{
    body::Body,
    extract::Path,
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH},
    },
    response::{IntoResponse, Response},
};
use rust_embed::{EmbeddedFile, RustEmbed};

const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE: &str = "no-cache";

#[derive(RustEmbed)]
#[folder = "../../packages/app/dist"]
struct Assets;

pub async fn index(headers: HeaderMap) -> Response {
    serve("index.html", REVALIDATE_CACHE, &headers)
}

pub async fn manifest(headers: HeaderMap) -> Response {
    serve("manifest.webmanifest", REVALIDATE_CACHE, &headers)
}

pub async fn asset(Path(path): Path<String>, headers: HeaderMap) -> Response {
    serve(&format!("assets/{path}"), IMMUTABLE_CACHE, &headers)
}

fn serve(path: &str, cache_control: &'static str, request_headers: &HeaderMap) -> Response {
    let Some(file) = Assets::get(path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let etag = etag(&file);

    if matches_etag(request_headers, &etag) {
        return response(
            StatusCode::NOT_MODIFIED,
            Body::empty(),
            cache_control,
            &etag,
        );
    }

    let content_type = mime_guess::from_path(path).first_or_octet_stream();
    let content_length = file.data.len();
    let mut response = response(StatusCode::OK, body(file.data), cache_control, &etag);
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(content_type.as_ref()).expect("MIME type must be a valid header"),
    );
    response.headers_mut().insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&content_length.to_string())
            .expect("asset length must be a valid header"),
    );
    response
}

fn response(status: StatusCode, body: Body, cache_control: &'static str, etag: &str) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(etag).expect("asset ETag must be a valid header"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
}

fn body(data: Cow<'static, [u8]>) -> Body {
    match data {
        Cow::Borrowed(data) => Body::from(data),
        Cow::Owned(data) => Body::from(data),
    }
}

fn etag(file: &EmbeddedFile) -> String {
    let hash = file.metadata.sha256_hash();
    let mut value = String::with_capacity(hash.len() * 2 + 2);
    value.push('"');
    for byte in hash {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value.push('"');
    value
}

fn matches_etag(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*" || candidate.trim_start_matches("W/") == etag
            })
        })
}

#[cfg(test)]
mod tests {
    use super::Assets;

    #[test]
    fn embeds_the_page_and_worker_entrypoints() {
        assert!(Assets::get("index.html").is_some());
        assert!(Assets::get("manifest.webmanifest").is_some());
        assert!(
            Assets::iter().any(|path| path.starts_with("assets/worker-") && path.ends_with(".js"))
        );
    }
}
