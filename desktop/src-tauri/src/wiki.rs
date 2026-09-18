use atomicwrites::{AllowOverwrite, AtomicFile};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Origin {
    Fixture,
    ConnectedReadOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Article {
    id: String,
    title: String,
    summary: String,
    url: String,
    provider: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WikiCache {
    schema_version: u32,
    provider: String,
    origin: Origin,
    fetched_at: u64,
    articles: Vec<Article>,
}

fn validate(cache: &WikiCache) -> io::Result<()> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidData, "invalid Wiki cache");
    if cache.schema_version != 1
        || cache.provider.is_empty()
        || cache.provider.len() > 100
        || cache.articles.len() > 100
    {
        return Err(invalid());
    }
    for article in &cache.articles {
        let url = tauri::Url::parse(&article.url).map_err(|_| invalid())?;
        if article.provider != cache.provider
            || article.id.len() > 200
            || article.title.len() > 1000
            || article.summary.len() > 10000
            || article.url.len() > 2000
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn load_at(directory: &Path) -> io::Result<Option<WikiCache>> {
    let path = directory.join("wiki-cache-v1.json");
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if bytes.len() > 2_000_000 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Wiki cache too large",
        ));
    }
    let cache: WikiCache = serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    validate(&cache)?;
    Ok(Some(cache))
}

fn store_at(directory: &Path, cache: &WikiCache) -> io::Result<()> {
    validate(cache)?;
    if let Some(previous) = load_at(directory)? {
        if previous.provider != cache.provider || previous.origin != cache.origin {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Wiki cache provenance mismatch",
            ));
        }
    }
    fs::create_dir_all(directory)?;
    let bytes = serde_json::to_vec(cache)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    AtomicFile::new(directory.join("wiki-cache-v1.json"), AllowOverwrite)
        .write(|file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .map_err(|error| io::Error::other(error.to_string()))
}

#[tauri::command]
pub fn load_wiki_cache(app: AppHandle) -> Result<Option<WikiCache>, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Wiki 앱 데이터 경로 오류")?;
    load_at(&directory).map_err(|_| "Wiki cache 읽기 오류: 기존 파일은 보존했습니다.".into())
}

#[tauri::command]
pub fn store_wiki_cache(app: AppHandle, cache: WikiCache) -> Result<(), String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "Wiki 앱 데이터 경로 오류")?;
    store_at(&directory, &cache).map_err(|_| "Wiki cache 저장 오류".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_roundtrip_and_missing_are_distinct() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        assert_eq!(load_at(directory.path())?, None);
        let cache = WikiCache {
            schema_version: 1,
            provider: "fixture".into(),
            origin: Origin::Fixture,
            fetched_at: 123,
            articles: vec![Article {
                id: "fixture-1".into(),
                title: "가상".into(),
                summary: "인공 예시".into(),
                url: "https://example.invalid/wiki/1".into(),
                provider: "fixture".into(),
            }],
        };
        store_at(directory.path(), &cache)?;
        assert_eq!(load_at(directory.path())?, Some(cache));
        Ok(())
    }
    #[test]
    fn corrupt_cache_is_preserved() -> Result<(), Box<dyn std::error::Error>> {
        let directory = tempfile::tempdir()?;
        let path = directory.path().join("wiki-cache-v1.json");
        fs::write(&path, b"broken")?;
        assert!(load_at(directory.path()).is_err());
        assert_eq!(fs::read(path)?, b"broken");
        Ok(())
    }
    #[test]
    fn extra_sensitive_fields_are_rejected() {
        let result = serde_json::from_str::<WikiCache>(
            r#"{"schemaVersion":1,"provider":"fixture","origin":"fixture","fetchedAt":1,"articles":[],"transcript":"forbidden"}"#,
        );
        assert!(result.is_err());
    }
    #[test]
    fn unsafe_links_and_unknown_schema_are_rejected() {
        let mut cache = WikiCache {
            schema_version: 1,
            provider: "fixture".into(),
            origin: Origin::Fixture,
            fetched_at: 123,
            articles: vec![Article {
                id: "fixture-1".into(),
                title: "가상".into(),
                summary: "인공 예시".into(),
                url: "javascript:alert(1)".into(),
                provider: "fixture".into(),
            }],
        };
        assert!(validate(&cache).is_err());
        cache.articles.clear();
        cache.schema_version = 2;
        assert!(validate(&cache).is_err());
    }
}
