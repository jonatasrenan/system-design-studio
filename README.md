# System Design Studio

A harness for practicing interview system design with [Claude Code](https://claude.com/claude-code). The conversation happens in the terminal; a web panel shows the design's artifacts in real time — requirements, estimates, decisions, diagram — updated on every exchange. Each design becomes a directory of files you can reread, compare, and share as a design doc.

## Requirements

Node.js 20 or newer. No npm dependencies — the viewer is a native HTTP server and the front-end libs (Mermaid, marked) are vendored in `viewer/public/vendor/`. Only design sharing (optional, at the end of this file) needs more: an authenticated AWS CLI.

## Usage

```bash
node viewer/server.mjs        # panel at http://localhost:4400 (PORT changes the port)
claude                        # in another terminal, at the repo root
```

New to the studio? **[FLUXO.md](FLUXO.md)** is the end-to-end usage guide: a diagram of the whole flow, a step-by-step of what to say and what to expect, and a table of "signs you're off the rails and what to do".

The commands below are skills in `.claude/skills/`: they become available by running `claude` from this repository's root (and trusting the directory when it asks), together with the instructions in `CLAUDE.md` and the consistency hook in `.claude/settings.json`.

| Command | What it does |
|---|---|
| `/design <problem>` | New study in studio mode: requirements → estimates → design → trade-offs → operations |
| `/design` | Lists existing designs to continue one |
| `/interview` | Solo mock: Claude is both interviewer and scribe |
| `/interviewer` | Three-way mock: this Claude is only the interviewer; another Claude, in another session, supports the candidate |
| `/review` | Adversarial review against the failure classes in `guardrails.md` |
| `/grade` | Grading against the rubric in `rubric.md` + a study plan |
| `/harness-eval` | Evaluates the harness (not the candidate): deterministic eval + semantic judge |

You can also just talk in natural language ("let's design a URL shortener") — `CLAUDE.md` maps the intent to the right flow.

## How it's organized

| Path | Role |
|---|---|
| `sessions/<slug>/` | One directory per design: numbered `.md` files (become tabs), `diagram.mmd` (Mermaid, single source for the design), `scorecard.json` (executive panel), `meta.json` |
| `rubric.md` | Interview criteria, scores 1-4 |
| `guardrails.md` | 34-item checklist across three blocks (failure classes, data & contract, domain & modeling); five verdicts (PASS/FALHA/N-A/premise-to-validate/accepted-risk); no design concludes with an open failure |
| `learnings.template.md` | Seed for the memory of recurring mistakes (from `aberto` to `dominado`), which feeds back into the next sessions |
| `padroes.template.md` | Seed for decisions already resolved across designs, each with the short defense ready |
| `argumentario.template.md` | Seed for the repertoire of decisions with the short defense ready — pre-interview review |
| `tools/` | Deterministic mechanical IO: session and stage creation, scorecard patching, consistency checking |
| `viewer/` | Node server with a file watcher + SSE, and the panel's front end |
| `.env.example` | Seed for personal configuration (bucket, distribution, AWS profile, port) |
| `CLAUDE.md` | The instructions that drive the agent: phases, propagation protocol, writing rules |

**What's yours never becomes a commit.** Your sessions (`sessions/*`), your memory (`learnings.md`, `padroes.md`, and `argumentario.md`, created from the `.template.md` files on first use), and your configuration (`.env`) are in `.gitignore`. That way you can study on top of a clone, or a fork, without your design content ever showing up as a change to send back upstream. To version your own, use a different repository — or remove those lines from `.gitignore`, knowing what you're publishing.

## Two pieces that deserve an explanation

**Premise propagation.** The pipeline is a DAG: changing a requirement invalidates estimates, design, and costs that depend on it. `tools/check.mjs` compares against the last baseline and deterministically lists what got left behind; a Stop hook (`.claude/settings.json`) blocks the end of the turn while there's pending propagation, with a 2-minute grace period for the session the agent just touched.

**Sharing a design.** `tools/share.mjs` publishes a session as a static page (the same panel, with the data embedded) in an S3 bucket behind a CDN — useful for the interviewer to follow along live. It's optional, calls the **AWS CLI** (`aws s3 cp`, `aws cloudfront create-invalidation`), and needs configuration:

```bash
cp .env.example .env                     # and fill in:
#   SD_SHARE_BUCKET=my-bucket             (required)
#   SD_SHARE_BASE=https://example.com     (required: public URL in front of the bucket)
#   SD_SHARE_DIST=E1234567890ABC          (optional: CloudFront distribution to invalidate)
#   AWS_PROFILE=...                       (optional: inherits the environment)

node tools/share.mjs <slug>              # publishes; --dry-run just generates the HTML, without touching AWS
node tools/share.mjs <slug> --off        # pauses auto-republishing
node tools/share.mjs <slug> --delete     # takes it down (sharing again returns the same URL)
```

`.env` stays out of version control (the repository ships only `.env.example`), and a variable exported in the shell wins over the file. Without the two required ones, the command fails saying what's missing, without calling AWS; the rest of the harness works offline.

## License

MIT — see [LICENSE](LICENSE).
