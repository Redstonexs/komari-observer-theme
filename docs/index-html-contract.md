# The `index.html` contract

Komari does not template this file. It performs a handful of **blind global
substring replacements** on the built `dist/index.html` before serving it
(`web/public/public.go`). That makes `index.html` unusually fragile in ways that
are invisible at build time and only show up on a live server.

`scripts/verify-dist.mjs` enforces everything below; CI runs it before any
release is cut.

## The three sentinels

These strings must survive the build **byte for byte**:

| # | Sentinel | Replaced with |
| --- | --- | --- |
| 1 | a `title` element whose text is exactly `Komari Monitor` | the operator's configured sitename |
| 2 | the description text `A simple server monitor tool` followed by a full stop | the operator's configured description |
| 3 | the opening `html` tag written as `lang="en"` | rewritten from the **`language` cookie** — not localStorage |

Sentinel 2 is replaced at **every** occurrence in the file, which is why
`og:description` and `twitter:description` deliberately carry the same string —
they get the operator's description for free.

The server also injects `custom_head` immediately before the closing `head` tag
and `custom_body` before the closing `body` tag.

## Three ways to break this file

All three have been hit in this repository. They share a shape: writing *about*
HTML inside HTML.

### 1. Never put a sentinel inside a comment

The replacement is a blind substring swap with no awareness of markup, so a
sentinel quoted inside a comment receives the operator's text too. If that text
happens to contain a comment terminator, the comment closes early and the rest
of it renders as visible page content — with operator-controlled markup in the
middle of it.

`verify-dist.mjs` fails the build if a sentinel appears inside a comment.

### 2. Never write a comment terminator inside a comment

Documenting the hazard above by quoting a literal `-` `-` `>` closes the comment
at that point. Everything after it renders as text on the page.

`verify-dist.mjs` counts comment openers and closers and fails when they differ.

### 3. Never write a closing `head` or `body` tag inside a comment

This is the nastiest of the three, because the page still loads and the console
stays completely silent.

Vite injects the bundled script and stylesheet tags immediately before the
**first** closing `head` tag it finds. If a comment mentions that tag literally,
Vite injects the entire application *inside the comment* — so the script never
executes, no stylesheet loads, and you get a blank white page with no errors
anywhere.

`verify-dist.mjs` strips comments and then asserts the module script and
stylesheet are still present.

## The rule

Describe markup in prose; never quote it. If you need to show a literal tag,
put it in this file, not in `index.html`.
