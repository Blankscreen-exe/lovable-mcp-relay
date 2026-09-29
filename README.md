# Lovable MCP relay

Claude Code cannot connect to Lovable's MCP server. It hangs on the handshake and
gives up after 30 seconds:

```
MCP server lovable connection timed out after 30000ms
```

The server is not down and your login is not the problem. Lovable sends two of
its replies in a way that never finishes, and a strict HTTP client waits forever
for the end that never comes. This is a small local program that sits between
Claude Code and Lovable, repairs those replies, and leaves everything else
untouched.

It has **no dependencies**. Node 18.17 or newer is all you need — and if you run
Claude Code, you already have Node.

---

## Quick start

```
git clone https://github.com/Blankscreen-exe/lovable-mcp-relay.git
cd lovable-mcp-relay
```

Then start it:

| | |
|---|---|
| **Windows** | double-click `start-relay.cmd` |
| **macOS / Linux** | `./start-relay.sh` |
| **any** | `npm run open` |

A setup window opens at `http://127.0.0.1:8787/ui`. In it you can:

- **paste a token** and have it checked against Lovable before it is kept
- **run a connection test** that performs a real handshake, including the reply
  that hangs without this relay
- **connect Claude Code** — it finds your `.mcp.json` files, shows you the exact
  change, writes it only when you confirm, and can put the original back

Then **restart Claude Code**. It reads that config only at startup.

Leave the relay running while you use Claude Code. To stop, close the window.

---

## Where the token comes from

The relay never asks you to log in. It looks for a Lovable login in this order:

1. its own saved copy, `.token-cache.json`
2. the login Claude Code already has, in `~/.claude/.credentials.json`

whichever is newer. If neither exists — a fresh machine, say — paste one into the
setup page.

It renews the access token by itself a couple of minutes before it lapses, so in
normal use there is nothing to do.

### What you can paste

Any of these; it works out which is which:

- the contents of a `.token-cache.json` from another machine
- a whole `~/.claude/.credentials.json` (it picks the Lovable entry out)
- a bare access token on its own

A chain **with** a refresh token keeps itself alive indefinitely. A bare access
token lasts about **8 hours** and then needs replacing — the page says so plainly
rather than letting it lapse quietly.

### Why it keeps its own copy

Lovable **rotates** refresh tokens: every renewal issues a new one and retires
the old. So the copy in Claude Code's file stops working as soon as the relay
renews once, and the only live copy is the relay's. That has one important
consequence, below.

---

## Using it on two machines

Because refresh tokens rotate, **two machines cannot share one login.** Whichever
renews first silently breaks the other.

The fix is one login per machine, and you can create them all from one computer:

1. Point `.mcp.json` at `https://mcp.lovable.dev` and run `/mcp` in Claude Code
   to log in. It will still fail to connect — that is expected; the login is the
   part you want.
2. Copy the resulting `.token-cache.json` (or the Lovable entry from
   `~/.claude/.credentials.json`) somewhere safe. That is machine one's chain.
3. Run `/mcp` again to log in a second time. That produces a **second, fully
   independent** chain for the next machine.
4. On the other machine, paste that chain into the setup page.

Each login is a separate grant and they renew independently — verified, not
assumed. Repeat step 3 for a third machine.

When copying this folder to another machine, **do not copy `.token-cache.json`**.
That is machine one's live chain, and carrying it across creates exactly the
conflict described above. The ignore rules already keep it out of git.

### If a login stops working

You get a clear error, never a hang. Because Claude Code logs in to whatever URL
is in `.mcp.json` — which is now the relay — recover it like this:

1. In the setup page, press **Revert**, or set the URL back to
   `https://mcp.lovable.dev` yourself. Restart Claude Code.
2. Run `/mcp` and log in. (It will fail to connect. Expected.)
3. Delete `.token-cache.json` in this folder.
4. Press **Connect** in the setup page again, and restart Claude Code.

---

## Security

This tool holds live access to your Lovable account, so:

- It listens on **loopback only** and refuses to start on any other address.
- The setup page carries a **one-off secret** generated at each start, and the
  API rejects any request without it. This matters: without it, any website open
  in your browser could quietly POST to `127.0.0.1` and replace your token or
  rewrite an MCP config. A remote page cannot read our page, so it cannot learn
  the secret, and the browser will not let it send the header either. The origin
  is checked as well.
- Tokens are **stripped from logs**, and the status API never returns one.
- `.token-cache.json` is written owner-only and is in `.gitignore`. Treat it like
  a password.
- Config editing is deliberately narrow: an **existing** `.mcp.json` or
  `mcp.json`, the `lovable` entry in it, and its `url`. It will not create config
  files anywhere, and it records the original value so Revert is exact.

---

## The defects this works around

Observed on Lovable MCP server **1.18.10**, September 2026. Everything else on
that server is healthy: all 40 tools, both resources and all three prompts answer
correctly in 120–600ms, and errors are reported properly.

### 1. An accepted notification never finishes

Send any JSON-RPC notification — for example `notifications/initialized`, the "I
am ready" message that completes the MCP handshake. Lovable replies:

```
HTTP/1.1 202 Accepted
transfer-encoding: chunked
```

…then sends no body bytes and no terminating chunk, holding the connection open
indefinitely. Measured with a raw socket: zero body bytes and no terminating
`0\r\n\r\n` after 10 seconds, on every attempt. Over a keep-alive connection the
client cannot tell the reply has ended.

The MCP specification says a 202 for an accepted notification carries no body, so
the fix is simply to finish the reply — ideally with `content-length: 0`.

This is fatal for Claude Code because it reads that body to the end before
treating the handshake as complete:

```js
if (P.status === 202) { if (await P.text?.()...
```

Raising the connection timeout does not help. It is a stall, not slowness.

**What the relay does:** replies with a clean, empty, properly finished 202 and
discards the upstream body, which never contained anything.

### 2. The 405 for the event stream is malformed

MCP clients open a `GET` stream to receive messages the server starts by itself.
Lovable does not offer one and answers `405 Method Not Allowed` — a fine answer,
but the reply is chunked with a corrupt chunk size, so a strict client rejects
the whole thing:

```
TypeError: terminated
  cause: Response does not match the HTTP/1.1 protocol (Invalid character in chunk size)
```

Lenient clients such as curl never notice. The body is a human-readable sentence
with no protocol meaning.

**What the relay does:** passes the status and the `Allow` header through with a
clean empty body.

### 3. A rejected probe, harmless

Claude Code sends its own `server/discover` probe before the handshake. Lovable
answers `400` with a body that also fails to read. Claude Code treats it as "not
supported" and carries on, so nothing breaks. Sent by hand as a plain request,
`server/discover` returns a normal `200` with a `method not found` error, so the
`400` appears to be about the enveloped shape Claude Code uses rather than the
method.

The relay deliberately does **not** paper over a failed body. When an upstream
reply breaks part way through, it tears the response down instead of ending it
neatly: a truncated reply that looks complete is more dangerous than a visible
failure, and inventing a reply the server never sent is not an option.

---

## One environment-specific oddity

Both repaired replies are sent with `Connection: close`, and the code explains
why. On the machine this was developed on, something between the relay and the
client rewrites an empty reply's `content-length: 0` into
`transfer-encoding: chunked`, leaving every other header untouched — confirmed by
comparing the exact bytes Node serialised against the bytes that arrived, same
process id and same `Date`. That rewrite would recreate the original hang, so the
relay does not rely on a length header surviving the trip: closing the connection
marks the end of the body whatever framing it was given.

It costs one extra connection per notification, which is a handful per session. A
trivial test server on the same port was unaffected, so this looks like traffic
inspection keyed to the process rather than anything about the port or loopback
in general.

---

## Tests

```
npm test            # both suites
npm run selftest    # the relay and the MCP handshake (18 checks)
npm run selftest:ui # the setup page, its API and its guards (24 checks)
```

Both talk to the real Lovable server and need a working login. The UI suite
writes only to a throwaway file in your system temp folder, never to a real
project.

While the relay is running:

```
npm run health      # which login is in use and when it renews
```

---

## Settings

All optional, read from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `127.0.0.1` | Must stay on loopback; anything else is refused |
| `OPEN_UI` | off | `1` opens the setup page at start (same as `--open`) |
| `LOVABLE_UPSTREAM` | `https://mcp.lovable.dev` | The real server |
| `LOVABLE_TOKEN_ENDPOINT` | `https://lovable.dev/oauth/token` | Where renewal happens |
| `LOVABLE_CLIENT_ID` | Claude Code's client id | Only used when a pasted token carries none |
| `UPSTREAM_TIMEOUT_MS` | `900000` | 15 minutes, because `send_message` can legitimately run for minutes |
| `LOG_BODIES` | off | `1` logs payloads. They contain project data, so off by default |

## Files

| File | What it is |
|---|---|
| `src/relay.mjs` | The server: proxying, the two repairs, streaming |
| `src/auth.mjs` | Reading, validating, caching and renewing the login |
| `src/ui.mjs` | The setup page's routes and API |
| `src/ui.html` | The setup page |
| `src/mcpconfig.mjs` | Finding and safely editing `.mcp.json` |
| `src/open.mjs` | Opening the page in an app-style window |
| `src/config.mjs` | Every setting and path in one place |
| `src/log.mjs` | Logging, with token redaction |
| `selftest.mjs` | Relay and handshake checks |
| `selftest-ui.mjs` | Setup page and API checks |

## When Lovable fixes their server

Point `.mcp.json` back at `https://mcp.lovable.dev` (the setup page's **Revert**
does this), restart Claude Code, and you can delete this folder. To check whether
the defect is still there, run `npm run selftest` and see whether the 202 repair
still reports itself in the relay log.
