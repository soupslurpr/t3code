use crate::{
    accessibility::Editable,
    error::{Error, Result},
    ibus::Commit,
    input::{Inputs, Key},
    portal::Session,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{sleep, timeout};

struct Selection {
    count: i32,
    start: i32,
    end: i32,
}

impl Selection {
    async fn read(e: &Editable) -> Option<Self> {
        if !e.focused().await {
            return None;
        }
        let (count, caret, n) = tokio::join!(
            e.text.character_count(),
            e.text.caret_offset(),
            e.text.get_n_selections()
        );
        let (count, caret) = (count.ok()?, caret.ok()?);
        let (start, end) = match n.ok()? {
            0 => (caret, caret),
            1 => e.text.get_selection(0).await.ok()?,
            _ => return None,
        };
        if !(0..=count).contains(&caret)
            || !(0..=count).contains(&start)
            || !(start..=count).contains(&end)
        {
            return None;
        }
        Some(Self { count, start, end })
    }

    async fn confirms(&self, e: &Editable, value: &str) -> bool {
        let n = value.chars().count() as i32;
        let Some(end) = self.start.checked_add(n) else {
            return false;
        };
        let Some(expected) = (self.count - (self.end - self.start)).checked_add(n) else {
            return false;
        };
        if !e.focused().await {
            return false;
        }
        let (count, caret, selected, text) = tokio::join!(
            e.text.character_count(),
            e.text.caret_offset(),
            e.text.get_n_selections(),
            e.text.get_text(self.start, end)
        );
        count.ok() == Some(expected)
            && caret.ok() == Some(end)
            && selected.ok() == Some(0)
            && text.is_ok_and(|s| s == value)
    }

    async fn insert(&self, e: &Editable, value: &str, interval: u64) -> Result<()> {
        let rejected =
            || Error::text("The focused control rejected insertion. The text may have changed.");
        if !e.focused().await {
            return Err(rejected());
        }
        if self.end > self.start
            && !e
                .edit
                .delete_text(self.start, self.end)
                .await
                .map_err(|_| rejected())?
        {
            return Err(rejected());
        }
        let mut pos = self.start;
        let mut insert = async |unit: &str| -> Result<()> {
            if !e.focused().await
                || !e
                    .edit
                    .insert_text(pos, unit, unit.len() as i32)
                    .await
                    .map_err(|_| rejected())?
            {
                return Err(rejected());
            }
            pos = pos
                .checked_add(unit.chars().count() as i32)
                .ok_or_else(rejected)?;
            if !e.text.set_caret_offset(pos).await.map_err(|_| rejected())? {
                return Err(rejected());
            }
            Ok(())
        };
        if interval == 0 {
            insert(value).await?;
        } else {
            for ch in value.chars() {
                insert(ch.encode_utf8(&mut [0; 4])).await?;
                sleep(Duration::from_millis(interval)).await;
            }
        }
        Ok(())
    }
}

fn normalize(value: &str, interval: u64) -> Result<String> {
    let text = value.replace("\r\n", "\n").replace('\r', "\n");
    let count = text.chars().count();
    if count > 10_000
        || interval > 250
        || count as u64 * interval > 60_000
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    {
        return Err(Error::invalid(
            "Text contains unsupported control characters or exceeds the typing limits.",
        ));
    }
    Ok(text)
}

fn fallback(text: &str, commit_only: bool) -> Result<&'static str> {
    if text.contains(['\n', '\t']) {
        return Err(Error::text(
            "Literal newline and tab need a focused editable accessibility control.",
        ));
    }
    Ok(if !commit_only && text.is_ascii() {
        "key-events"
    } else {
        "input-method"
    })
}

pub async fn enter(
    inputs: &mut Inputs,
    session: &Session,
    value: &str,
    interval: u64,
    commit_only: bool,
    submit: bool,
    required: bool,
) -> Result<Value> {
    let text = normalize(value, interval)?;
    let count = text.chars().count();
    let editable = if count == 0 {
        None
    } else {
        timeout(Duration::from_secs(3), Editable::find())
            .await
            .ok()
            .flatten()
    };
    let before = if let Some(e) = &editable {
        Selection::read(e).await
    } else {
        None
    };
    let delivery = if count == 0 {
        "none"
    } else if let (Some(e), Some(b)) = (&editable, &before) {
        if text.contains('\n') && !e.multiline {
            return Err(Error::text(
                "The focused control only accepts a single line.",
            ));
        }
        b.insert(e, &text, interval).await?;
        "accessibility"
    } else {
        let route = fallback(&text, commit_only || !inputs.can_type(session, &text))?;
        if route == "key-events" {
            for ch in text.chars() {
                inputs.chord(session, &[Key::character(ch)]).await?;
                if interval != 0 {
                    sleep(Duration::from_millis(interval)).await;
                }
            }
        } else {
            inputs.ibus = Some(Commit::start(text.clone(), interval));
            let result = inputs.ibus.as_mut().unwrap().wait().await;
            inputs.ibus.take();
            result?;
        }
        route
    };
    let exact = if count == 0 {
        true
    } else if let (Some(e), Some(b)) = (&editable, &before) {
        sleep(Duration::from_millis(50)).await;
        b.confirms(e, &text).await
    } else {
        false
    };
    if delivery == "accessibility" && !exact {
        return Err(Error::text(
            "The focused control did not confirm the exact insertion. Some text may have been inserted.",
        ));
    }
    let submission = if !submit {
        "not-requested"
    } else if required && !exact {
        "withheld-unverified"
    } else {
        sleep(Duration::from_millis(250)).await;
        if let Some(e) = &editable
            && !e.focused().await
        {
            return Err(Error::text("Focus changed before submission."));
        }
        inputs.chord(session, &[Key::parse("Enter")?]).await?;
        "submitted"
    };
    Ok(
        json!({"index":0,"type":if commit_only{"insert_text"}else{"type"},"requestedCodePoints":count,"acceptedCodePoints":count,
        "confirmedCodePoints":if exact{count}else{0},"verification":if exact{"exact"}else{"unavailable"},
        "delivery":delivery,"focusedEditable":editable.is_some(),"submission":submission}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn literal_controls_fail_before_fallback_and_unicode_is_never_physical() {
        assert_eq!(normalize("a\r\nb\rc", 0).unwrap(), "a\nb\nc");
        for s in ["a\nb", "a\tb"] {
            assert_eq!(
                fallback(s, false).unwrap_err().code,
                "exact-text-unavailable"
            );
        }
        assert_eq!(fallback("a😀", false).unwrap(), "input-method");
        assert_eq!(fallback("abc", true).unwrap(), "input-method");
        assert!(normalize("a\0b", 0).is_err());
    }
}
