#!/usr/bin/env python3
"""
Email-based AI editor for the When-To-Go travel blog.

Monitors ai-assistent@nichtagentur.at for emails from nico@tourradar.com,
uses AI to interpret edit instructions, updates articles, deploys, and replies.
"""

import imaplib
import smtplib
import email
import json
import os
import re
import subprocess
import sys
import time
import logging
from email.mime.text import MIMEText
from email.header import decode_header
from pathlib import Path
from datetime import datetime

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

IMAP_HOST = "mail.easyname.eu"
IMAP_PORT = 993
SMTP_HOST = "mail.easyname.eu"
SMTP_PORT = 587

EMAIL_USER = "i-am-a-user@nichtagentur.at"
EMAIL_PASS = "i_am_an_AI_password_2026"
ALLOWED_SENDER = "nico@tourradar.com"

PROJECT_DIR = Path.home() / "Projects" / "when-to-go"
CONTENT_DIR = PROJECT_DIR / "content" / "countries"
QUEUE_FILE = PROJECT_DIR / "data" / "queue.json"

POLL_INTERVAL = 30          # seconds between IMAP checks
MAX_CONSECUTIVE_FAILS = 5   # before increasing backoff
BACKOFF_INTERVAL = 60       # seconds after too many failures

SITE_URL = "https://nichtagentur.github.io/when-to-go"

# OpenRouter API for AI calls
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Model fallback chain (same as the JS blog pipeline)
MODELS = [
    "google/gemini-2.0-flash-001",   # cheapest
    "deepseek/deepseek-chat",
    "openai/gpt-4o-mini",
]

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("email-editor")

# ---------------------------------------------------------------------------
# AI helpers (OpenRouter with 3-model fallback)
# ---------------------------------------------------------------------------

def call_ai(system_prompt: str, user_prompt: str, max_tokens: int = 4000) -> str:
    """Call OpenRouter with the 3-model fallback chain. Returns response text."""
    import urllib.request

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    last_error = None
    for model in MODELS:
        try:
            payload = json.dumps({
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "max_tokens": max_tokens,
                "temperature": 0.4,
            }).encode()

            req = urllib.request.Request(
                "https://openrouter.ai/api/v1/chat/completions",
                data=payload,
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode())

            content = data["choices"][0]["message"]["content"].strip()
            if len(content) < 50:
                raise ValueError(f"Response too short ({len(content)} chars)")

            log.info(f"AI call succeeded with {model}")
            return content

        except Exception as e:
            last_error = e
            log.warning(f"Model {model} failed: {e}")
            continue

    raise RuntimeError(f"All AI models failed. Last error: {last_error}")


def call_ai_json(system_prompt: str, user_prompt: str) -> dict:
    """Call AI and parse the response as JSON."""
    raw = call_ai(system_prompt, user_prompt, max_tokens=500)
    # Extract JSON from possible markdown code fences
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if match:
        raw = match.group(1)
    # Try to find a raw JSON object
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        return json.loads(match.group(0))
    raise ValueError(f"Could not parse JSON from AI response: {raw[:200]}")

# ---------------------------------------------------------------------------
# Email helpers
# ---------------------------------------------------------------------------

def connect_imap() -> imaplib.IMAP4_SSL:
    """Connect to the IMAP server and select INBOX."""
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(EMAIL_USER, EMAIL_PASS)
    conn.select("INBOX")
    return conn


def get_unread_from_sender(conn: imaplib.IMAP4_SSL) -> list:
    """Return list of UIDs for unread emails from the allowed sender."""
    status, data = conn.search(None, f'(FROM "{ALLOWED_SENDER}" UNSEEN)')
    if status != "OK" or not data[0]:
        return []
    return data[0].split()


def fetch_email(conn: imaplib.IMAP4_SSL, uid: bytes) -> dict:
    """Fetch an email by UID and return subject + body text."""
    status, data = conn.fetch(uid, "(RFC822)")
    if status != "OK":
        return None

    msg = email.message_from_bytes(data[0][1])

    # Decode subject
    subject_parts = decode_header(msg["Subject"] or "")
    subject = ""
    for part, encoding in subject_parts:
        if isinstance(part, bytes):
            subject += part.decode(encoding or "utf-8", errors="replace")
        else:
            subject += part

    # Decode body (plain text preferred)
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                charset = part.get_content_charset() or "utf-8"
                body = part.get_payload(decode=True).decode(charset, errors="replace")
                break
    else:
        charset = msg.get_content_charset() or "utf-8"
        body = msg.get_payload(decode=True).decode(charset, errors="replace")

    # Double-check sender
    sender = msg.get("From", "")
    if ALLOWED_SENDER not in sender.lower():
        log.warning(f"Sender mismatch: {sender}")
        return None

    return {"subject": subject, "body": body, "from": sender}


def mark_as_seen(conn: imaplib.IMAP4_SSL, uid: bytes):
    """Mark an email as seen/read."""
    conn.store(uid, "+FLAGS", "\\Seen")


def send_reply(to_addr: str, subject: str, body: str):
    """Send a reply email via SMTP."""
    msg = MIMEText(body, "plain", "utf-8")
    msg["From"] = EMAIL_USER
    msg["To"] = to_addr
    msg["Subject"] = subject

    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.starttls()
        server.login(EMAIL_USER, EMAIL_PASS)
        server.send_message(msg)

    log.info(f"Reply sent to {to_addr}: {subject}")

# ---------------------------------------------------------------------------
# Article helpers
# ---------------------------------------------------------------------------

def get_article_slugs() -> list[str]:
    """Return list of existing country article slugs (filenames without .md)."""
    slugs = []
    for f in CONTENT_DIR.glob("*.md"):
        if f.name == "_index.md":
            continue
        slugs.append(f.stem)
    return sorted(slugs)


def read_article(slug: str) -> str:
    """Read a country article's markdown content."""
    path = CONTENT_DIR / f"{slug}.md"
    return path.read_text(encoding="utf-8")


def write_article(slug: str, content: str):
    """Write updated markdown content to a country article."""
    path = CONTENT_DIR / f"{slug}.md"
    path.write_text(content, encoding="utf-8")
    log.info(f"Updated article: {slug}")

# ---------------------------------------------------------------------------
# Intent classification
# ---------------------------------------------------------------------------

def classify_intent(subject: str, body: str, slugs: list[str]) -> dict:
    """Use a cheap AI call to classify what the email is asking for."""
    system_prompt = (
        "You classify email instructions for a travel blog editor. "
        "Return ONLY valid JSON with these fields:\n"
        '  "action": "update_article" | "create_article" | "unknown"\n'
        '  "target_slug": slug string (for updates) or new slug (for creates)\n'
        '  "country_name": full country name (for creates)\n'
        '  "summary": one-line summary of what to do\n'
        '  "details": the full edit instructions\n'
    )
    user_prompt = (
        f"Email subject: {subject}\n"
        f"Email body: {body}\n\n"
        f"Existing article slugs: {', '.join(slugs)}\n\n"
        "Classify this email and return JSON."
    )
    return call_ai_json(system_prompt, user_prompt)

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

def update_article(slug: str, instructions: str) -> str:
    """Update an existing article based on AI-interpreted instructions."""
    current_content = read_article(slug)

    system_prompt = (
        "You are Elena Vasquez, senior travel editor with 15 years of experience. "
        "You are editing an existing travel article. Return the COMPLETE updated "
        "markdown file (including frontmatter). Make only the requested changes -- "
        "do NOT rewrite sections that don't need changing. Preserve all frontmatter "
        "fields, formatting, HTML comments, and structure. Update the 'lastmod' date "
        f'to "{datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")}".'
    )
    user_prompt = (
        f"INSTRUCTIONS: {instructions}\n\n"
        f"CURRENT ARTICLE:\n{current_content}"
    )

    updated = call_ai(system_prompt, user_prompt, max_tokens=8000)

    # Strip markdown code fences if the AI wrapped the response
    if updated.startswith("```"):
        updated = re.sub(r"^```\w*\n?", "", updated)
        updated = re.sub(r"\n?```$", "", updated)

    write_article(slug, updated)
    return f"Updated {slug}.md"


def create_article(slug: str, country_name: str) -> str:
    """Create a new article by calling the existing Node.js generator."""
    log.info(f"Creating new article: {slug} ({country_name})")

    # Source env vars so the Node script has all API keys
    result = subprocess.run(
        ["bash", "-c", f"source ~/.env && node scripts/generate-article.js {slug}"],
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
        timeout=300,
    )

    if result.returncode != 0:
        error_msg = result.stderr or result.stdout or "Unknown error"
        raise RuntimeError(f"Article generation failed: {error_msg[:500]}")

    log.info(f"Article created: {slug}")
    return f"Created new article: {slug}.md"

# ---------------------------------------------------------------------------
# Deploy (hugo build + git push)
# ---------------------------------------------------------------------------

def deploy(commit_message: str) -> str:
    """Build with Hugo, then git add/commit/push."""
    # Hugo build as sanity check
    log.info("Running hugo build...")
    result = subprocess.run(
        ["hugo", "--minify"],
        cwd=str(PROJECT_DIR),
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Hugo build failed: {result.stderr[:500]}")

    log.info("Hugo build OK. Pushing to git...")

    # Git add, commit, push
    commands = [
        ["git", "add", "-A"],
        ["git", "commit", "-m", commit_message],
        ["git", "push"],
    ]
    for cmd in commands:
        result = subprocess.run(
            cmd,
            cwd=str(PROJECT_DIR),
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            # "nothing to commit" is OK
            if "nothing to commit" in (result.stdout + result.stderr):
                log.info("Nothing to commit -- already up to date")
                return "No changes to deploy"
            raise RuntimeError(f"Git command failed ({' '.join(cmd)}): {result.stderr[:300]}")

    log.info("Deployed successfully")
    return "Deployed to GitHub Pages"

# ---------------------------------------------------------------------------
# Process a single email
# ---------------------------------------------------------------------------

def process_email(email_data: dict) -> str:
    """Process one email: classify -> act -> deploy -> reply."""
    subject = email_data["subject"]
    body = email_data["body"]
    full_instructions = f"{subject}\n{body}".strip()

    log.info(f"Processing email: {subject}")

    # Step 1: Classify intent
    slugs = get_article_slugs()
    intent = classify_intent(subject, body, slugs)
    action = intent.get("action", "unknown")
    target_slug = intent.get("target_slug", "")
    country_name = intent.get("country_name", target_slug.replace("-", " ").title())
    details = intent.get("details", full_instructions)
    summary = intent.get("summary", subject)

    log.info(f"Intent: action={action}, slug={target_slug}, summary={summary}")

    # Step 2: Execute action
    if action == "update_article":
        if target_slug not in slugs:
            return send_clarification(
                subject,
                f"I couldn't find an article with slug '{target_slug}'. "
                f"Available articles: {', '.join(slugs)}. "
                "Could you clarify which article to update?"
            )
        result = update_article(target_slug, details)
        commit_msg = f"email-editor: update {target_slug} -- {summary}"

    elif action == "create_article":
        if target_slug in slugs:
            return send_clarification(
                subject,
                f"Article '{target_slug}' already exists. "
                "Did you mean to update it instead? Please clarify."
            )
        result = create_article(target_slug, country_name)
        commit_msg = f"email-editor: create {target_slug}"

    elif action == "unknown":
        return send_clarification(
            subject,
            f"I wasn't sure what to do with your request:\n\n"
            f"Subject: {subject}\n{body}\n\n"
            "Could you rephrase? I can:\n"
            "- Update an existing article (e.g., 'Update Argentina to mention wine regions')\n"
            "- Create a new article (e.g., 'Create an article about France')"
        )
    else:
        return send_clarification(subject, f"Unknown action: {action}")

    # Step 3: Deploy
    deploy_result = deploy(commit_msg)

    # Step 4: Reply with confirmation
    article_url = f"{SITE_URL}/countries/{target_slug}/"
    reply_body = (
        f"Done! Here's what I did:\n\n"
        f"Action: {summary}\n"
        f"Result: {result}\n"
        f"Deploy: {deploy_result}\n\n"
        f"View it here: {article_url}\n\n"
        f"(Note: GitHub Pages may take 1-2 minutes to update.)"
    )
    send_reply(ALLOWED_SENDER, f"Re: {subject}", reply_body)
    return result


def send_clarification(original_subject: str, message: str) -> str:
    """Reply asking for clarification. Returns a status string."""
    send_reply(
        ALLOWED_SENDER,
        f"Re: {original_subject} (need clarification)",
        message
    )
    log.info("Sent clarification request")
    return "Sent clarification"

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    """Main polling loop -- check for new emails every POLL_INTERVAL seconds."""
    if not OPENROUTER_API_KEY:
        log.error("OPENROUTER_API_KEY not set. Source ~/.env first.")
        sys.exit(1)

    log.info("=" * 60)
    log.info("Email Editor started -- monitoring for emails")
    log.info(f"  IMAP: {EMAIL_USER} @ {IMAP_HOST}")
    log.info(f"  Allowed sender: {ALLOWED_SENDER}")
    log.info(f"  Poll interval: {POLL_INTERVAL}s")
    log.info(f"  Project: {PROJECT_DIR}")
    log.info("=" * 60)

    consecutive_fails = 0

    while True:
        try:
            conn = connect_imap()
            uids = get_unread_from_sender(conn)

            if uids:
                log.info(f"Found {len(uids)} unread email(s) from {ALLOWED_SENDER}")

            for uid in uids:
                try:
                    email_data = fetch_email(conn, uid)
                    if email_data is None:
                        mark_as_seen(conn, uid)
                        continue

                    result = process_email(email_data)
                    mark_as_seen(conn, uid)
                    log.info(f"Finished processing: {result}")

                except Exception as e:
                    log.error(f"Error processing email UID {uid}: {e}")
                    # Try to reply with error
                    try:
                        send_reply(
                            ALLOWED_SENDER,
                            "Email Editor Error",
                            f"Something went wrong processing your email:\n\n{e}\n\n"
                            "Please try again or check the logs."
                        )
                    except Exception:
                        pass
                    # Mark as seen so we don't retry endlessly
                    mark_as_seen(conn, uid)

            try:
                conn.logout()
            except Exception:
                pass

            consecutive_fails = 0
            time.sleep(POLL_INTERVAL)

        except Exception as e:
            consecutive_fails += 1
            if consecutive_fails >= MAX_CONSECUTIVE_FAILS:
                wait = BACKOFF_INTERVAL
                log.error(f"IMAP connection failed ({consecutive_fails}x): {e}. Backing off {wait}s")
            else:
                wait = POLL_INTERVAL
                log.warning(f"IMAP error: {e}. Retrying in {wait}s")
            time.sleep(wait)


if __name__ == "__main__":
    main()
