//! Exporting a document's annotations.
//!
//! Highlights and bookmarks live in the document's `state.json`. This turns
//! them into something readable elsewhere — Markdown for notes apps, JSON
//! for tooling, CSV for spreadsheets.

use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::AppHandle;

use crate::library;

fn iso_date(ms: u64) -> String {
    // Civil date from a unix millisecond stamp (Howard Hinnant's algorithm).
    let days = (ms / 86_400_000) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn num_of(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|x| x.as_u64()).unwrap_or(0)
}

fn csv_cell(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Highlights, in the order they appear in the document.
fn ordered_highlights(state: &Value) -> Vec<&Value> {
    let mut items: Vec<&Value> = state
        .get("highlights")
        .and_then(|h| h.as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_default();
    items.sort_by(|a, b| {
        str_of(a, "page")
            .cmp(&str_of(b, "page"))
            .then(num_of(a, "createdAt").cmp(&num_of(b, "createdAt")))
    });
    items
}

fn to_markdown(meta: &library::DocMeta, state: &Value) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", meta.title));
    out.push_str(&format!("- Source: {}\n", meta.source_url));
    if let Some(a) = &meta.author {
        if !a.trim().is_empty() {
            out.push_str(&format!("- Author: {a}\n"));
        }
    }
    out.push_str(&format!("- Captured: {}\n", iso_date(meta.created_at)));

    let highlights = ordered_highlights(state);
    let bookmarks = state
        .get("bookmarks")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();
    out.push_str(&format!(
        "- {} highlight{}, {} bookmark{}\n\n",
        highlights.len(),
        if highlights.len() == 1 { "" } else { "s" },
        bookmarks.len(),
        if bookmarks.len() == 1 { "" } else { "s" }
    ));

    if !highlights.is_empty() {
        out.push_str("## Highlights\n\n");
        let mut current_page = String::new();
        for h in &highlights {
            let page = str_of(h, "page");
            if page != current_page && !page.is_empty() && page != "/" {
                out.push_str(&format!("### {page}\n\n"));
                current_page = page;
            }
            for line in str_of(h, "exact").lines() {
                out.push_str(&format!("> {line}\n"));
            }
            let color = str_of(h, "color");
            let when = num_of(h, "createdAt");
            let mut notes: Vec<String> = Vec::new();
            if !color.is_empty() {
                notes.push(color);
            }
            if when > 0 {
                notes.push(iso_date(when));
            }
            if h.get("orphaned").and_then(|o| o.as_bool()).unwrap_or(false) {
                notes.push("no longer found in the document".into());
            }
            if !notes.is_empty() {
                out.push_str(&format!("\n*{}*\n", notes.join(" · ")));
            }
            out.push('\n');
        }
    }

    if !bookmarks.is_empty() {
        out.push_str("## Bookmarks\n\n");
        for b in &bookmarks {
            let pct = (b.get("ratio").and_then(|r| r.as_f64()).unwrap_or(0.0) * 100.0).round();
            out.push_str(&format!("- {} — {pct:.0}%\n", str_of(b, "label")));
        }
        out.push('\n');
    }

    if highlights.is_empty() && bookmarks.is_empty() {
        out.push_str("_No annotations yet._\n");
    }
    out
}

fn to_csv(state: &Value) -> String {
    let mut out = String::from("type,page,color,created,text\n");
    for h in ordered_highlights(state) {
        out.push_str(&format!(
            "highlight,{},{},{},{}\n",
            csv_cell(&str_of(h, "page")),
            csv_cell(&str_of(h, "color")),
            csv_cell(&iso_date(num_of(h, "createdAt"))),
            csv_cell(&str_of(h, "exact")),
        ));
    }
    if let Some(bs) = state.get("bookmarks").and_then(|b| b.as_array()) {
        for b in bs {
            out.push_str(&format!(
                "bookmark,{},,{},{}\n",
                csv_cell(&str_of(b, "page")),
                csv_cell(&iso_date(num_of(b, "createdAt"))),
                csv_cell(&str_of(b, "label")),
            ));
        }
    }
    out
}

fn to_text(meta: &library::DocMeta, state: &Value) -> String {
    let mut out = format!("{}\n{}\n\n", meta.title, meta.source_url);
    for h in ordered_highlights(state) {
        out.push_str(&str_of(h, "exact"));
        out.push_str("\n\n");
    }
    out
}

/// Renders a document's annotations. `format` is markdown | json | csv | txt.
#[tauri::command]
pub fn render_annotations(app: AppHandle, id: String, format: String) -> Result<String, String> {
    let dir = library::doc_dir(&app, &id)?;
    if !dir.exists() {
        return Err("document not found".into());
    }
    let summary = library::summary_for(&dir)?;
    let state = summary.state.clone().unwrap_or(Value::Null);

    Ok(match format.as_str() {
        "json" => serde_json::to_string_pretty(&serde_json::json!({
            "title": summary.meta.title,
            "sourceUrl": summary.meta.source_url,
            "author": summary.meta.author,
            "capturedAt": summary.meta.created_at,
            "highlights": state.get("highlights").cloned().unwrap_or(Value::Array(vec![])),
            "bookmarks": state.get("bookmarks").cloned().unwrap_or(Value::Array(vec![])),
        }))
        .map_err(|e| e.to_string())?,
        "csv" => to_csv(&state),
        "txt" => to_text(&summary.meta, &state),
        _ => to_markdown(&summary.meta, &state),
    })
}

/// Renders and writes annotations to a file.
#[tauri::command]
pub fn export_annotations(
    app: AppHandle,
    id: String,
    dest: String,
    format: String,
) -> Result<String, String> {
    let body = render_annotations(app, id, format.clone())?;
    let ext = match format.as_str() {
        "json" => "json",
        "csv" => "csv",
        "txt" => "txt",
        _ => "md",
    };
    let mut path = PathBuf::from(&dest);
    if path.extension().is_none() {
        path.set_extension(ext);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create folder: {e}"))?;
    }
    fs::write(&path, body).map_err(|e| format!("could not write file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta() -> library::DocMeta {
        library::DocMeta {
            id: "doc".into(),
            title: "A Story".into(),
            source_url: "https://example.com/story".into(),
            author: Some("A Writer".into()),
            excerpt: None,
            created_at: 1_700_000_000_000,
            size_bytes: 0,
            cover: None,
            scripts: true,
            format: 2,
        }
    }

    fn state() -> Value {
        json!({
            "highlights": [
                { "id": "h1", "exact": "the first quote", "color": "sun", "createdAt": 1, "page": "/" },
                { "id": "h2", "exact": "a later quote", "color": "mint", "createdAt": 2, "page": "/part-two" },
            ],
            "bookmarks": [{ "id": "b1", "label": "Chapter 2", "ratio": 0.5, "createdAt": 3 }],
        })
    }

    #[test]
    fn markdown_contains_every_quote_and_groups_by_page() {
        let out = to_markdown(&meta(), &state());
        assert!(out.contains("# A Story"));
        assert!(out.contains("> the first quote"));
        assert!(out.contains("> a later quote"));
        assert!(out.contains("### /part-two"), "pages should be headed:\n{out}");
        assert!(out.contains("Chapter 2"));
        assert!(out.contains("2 highlights, 1 bookmark"));
    }

    #[test]
    fn csv_quotes_cells_containing_commas() {
        let st = json!({
            "highlights": [{ "id": "h", "exact": "one, two, three", "color": "sun", "createdAt": 1 }],
            "bookmarks": [],
        });
        let out = to_csv(&st);
        assert!(out.contains("\"one, two, three\""), "unescaped csv: {out}");
    }

    #[test]
    fn empty_document_says_so_rather_than_producing_a_stub() {
        let out = to_markdown(&meta(), &json!({ "highlights": [], "bookmarks": [] }));
        assert!(out.contains("_No annotations yet._"));
    }

    #[test]
    fn dates_render_correctly() {
        // 2023-11-14 UTC
        assert_eq!(iso_date(1_700_000_000_000), "2023-11-14");
        assert_eq!(iso_date(0), "1970-01-01");
    }
}
