# x6o4-tools — Let AI deliver your articles to your Kindle and your notes

[中文](README.md) | English

This is a free, open-source tool. It works together with [RSS Cloud](https://rss-cloud.x6o4.com), a cloud service that follows your RSS subscriptions.

**You need an RSS Cloud subscription before anything in this repository can work.**

## What it can do for you

1. **Push your unread articles to your Kindle.** Say to your AI assistant: "push my unread articles to Kindle". It picks out the articles worth a long read (announcements and video round-ups are skipped automatically), packs them into an e-book and sends it to your Kindle. After a successful send, those articles are marked as read automatically, so they won't be pushed twice. When there are too many for one email, the ones that didn't fit simply stay unread and ride along next time — nothing gets lost.
2. **Push your starred articles to your Kindle.** The articles you starred are packed into an e-book and sent to your Kindle. Your stars stay as they are.
3. **Save your starred articles into your notes.** Starred articles become note files inside an [Obsidian](https://obsidian.md) folder (a popular note-taking app). Running it again never creates duplicate files.

All of it takes one sentence from you. Afterwards the AI tells you which articles were sent, which were skipped, and why. If you think a skipped one deserved better, just say "push that one too".

## Before you start, prepare three things

1. **An RSS Cloud account with an active subscription** (email + password).
2. **A Kindle and its receive address.** You find this address on the Amazon website: log in → "Manage Your Content and Devices" → "Preferences" → "Personal Document Settings" → "Send-to-Kindle E-Mail Address". It looks like `xxxx@kindle.com`.
3. **An email account of your own** (Gmail, Outlook, QQ Mail, 163 — anything works). It does the actual sending.

Two things worth knowing in advance:

- Amazon's China store has ended its personal document service. Use the `@kindle.com` address of an **international** Amazon account.
- Your sending address must be added to Amazon's approved list first: "Personal Document Settings" → "Approved Personal Document E-mail List" → add your address. **Without this, e-books you send are silently dropped by Amazon, with no error message anywhere.**

## Installation (two ways, pick one)

### Way 1: let the AI install it (recommended)

Open the AI assistant you normally use (Codex, Workbuddy, ZCode, CLAUDE Code, …), send it this repository's address and say:

> Install and set up the tools and skills from this repository for me: https://github.com/veesong/x6o4-tools

The AI will do everything. It will stop only once: to have you type your password yourself in the terminal (a password should never pass through the AI — this is for your protection).

### Way 2: install it yourself

Your computer needs [Node.js](https://nodejs.org) first (pick version 18 or newer; installing is just a few "Next" clicks). Then open a terminal (on Windows: search for "Terminal" or "Command Prompt" in the Start menu) and type:

```bash
npm install -g x6o4-tools
```

If the download is slow or fails, retry with `npm install -g x6o4-tools --registry=https://registry.npmmirror.com`.

Once installed, the command-line tool is ready (type `x6o4` to check). If you also want the "AI skills" — the one-sentence pushing — run one more command:

```bash
x6o4 skills install
```

This installs the skills into the `.agents` folder (a shared location that AI assistants agreed on: Codex, Workbuddy and ZCode pick it up automatically; on CLAUDE Code it depends on your device's configuration — check that the install succeeded). Skills and the command-line tool come as one package: a later `npm update -g x6o4-tools` updates both together.

## First use: log in once, then never again

Type `x6o4 login` in a terminal. The first time, it asks which language the tool itself should speak:

`界面语言 / Interface language（1. 中文  2. English，回车/Enter = 自动 auto）：`

Type `2` for English (or press Enter to auto-detect from your system). The choice is remembered — every prompt, status line and error message will be in your language from then on. In daily use your AI assistant runs the commands for you anyway, so this mostly matters for the steps you operate yourself.

Then it asks two questions:

1. **Email:** type your RSS Cloud login email and press Enter.
2. **Password:** type your RSS Cloud password. Nothing appears on screen while typing — that's normal. Press Enter when done.

Seeing `✔ Authorized: <your email>` means success. **Your password is not saved.** What gets saved is a long string of characters (called a "long-term token") that represents the permission you just granted. It exists only on your own computer and can be revoked at any time (see "When something goes wrong" below).

Next, two more pieces of information go into the configuration (you can have the AI ask you for them and fill them in):

- Your Kindle receive address (`xxxx@kindle.com`)
- Your sending email address, and its "app password"

What is an "app password"? Email providers don't allow programs to send mail with your normal login password. Instead, they issue a separate password just for programs. Where to get one:

| Email | Where to get the app password |
|---|---|
| QQ Mail | Log in on the web → Settings → Account → enable SMTP service → generate an authorization code |
| 163 Mail | Settings → POP3/SMTP/IMAP → enable it and get the authorization code |
| Gmail | Turn on 2-Step Verification first, then create an app password under "My Account" |
| Outlook / iCloud | App passwords in the account security settings |

**Prefer not to apply for an app password? Send through agent mail instead.** agent mail is a standalone email product from Tencent (not the same thing as QQ Mail; it lives at agent.qq.com), built for AI assistants. It ships a small tool (agently-cli) that sends mail after a one-time click on an authorization link in the browser — no app password involved. To use it: register an agent mail address, have your AI assistant install that tool, run `agently-cli auth login` once in a terminal, and set `mail_transport` to `agently` in the configuration. Note that the sending address becomes this agent mail address — it also has to be on Amazon's approved list.

## Daily use (one sentence to your AI)

- "Push my unread articles to Kindle"
- "Push the articles I starred over the last month to Kindle"
- "Turn my starred articles into Markdown and save them into my notes"

The first time you use "save into notes", the AI asks which folder on your computer holds your note library. Tell it once — it remembers from then on.

Generated e-books and notes automatically take care of two common problems, with no setup on your side: **feeds that only provide a summary** are re-opened on their websites to get the full text; **images blocked by hotlink protection** are retried with a different download method. If you've turned on "fetch full text" or "bypass image hotlink protection" for a feed in the mobile app or the web console, the very same settings apply here.

Every article in a generated e-book ends with two links. **"Original"** leads back to the article's web page. **"Bookmark article"** is for the moment you're halfway through a piece on your Kindle and want to star it: open the link, tap "Save", done — no need to pick up your phone. Articles that are already starred simply show "Saved". The bookmark link is valid for 90 days and works for that one article only.

The language of the e-book follows you automatically: talk to the AI in English and the fixed texts of the book (contents, source, date and so on) plus the email body will be English; talk in Chinese, or whenever the AI is unsure, and the tool decides from your computer's system language.

## When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Token invalid or revoked | You changed your RSS Cloud password, or your account status changed | Run `x6o4 login` again |
| Not entitled / subscription required | Your RSS Cloud subscription expired | Renew it and continue |
| The email was sent, but the Kindle never received it | Your sending address is not on Amazon's approved list | Fix it as described under "Before you start", second note |
| You want to cut off this tool's access entirely | — | Tell your AI agent "log me out of RSS Cloud" — it runs `x6o4 logout` and revokes this computer's token. To revoke the tokens on all computers at once, change your RSS Cloud password (every token is revoked immediately) |

## Your privacy

- Your password exists only in the moment you type it. It is not stored, not passed on, and never visible to the AI.
- The long-term token is stored only on your own computer (in the `.x6o4-tools` folder under your user directory). It can read your articles, mark them as read and adjust per-feed reading settings — it cannot touch your password or your account settings.
- The "Bookmark article" links inside an e-book work for their own article only and expire after 90 days. Forwarding the e-book to someone else never leaks your token.
- Your article content travels only between your own computer and your own mailbox — no third party in between.
- You can take the permission back at any time (see the last row of the previous section).

## More documentation

- Detailed reference for every command (for you or your AI; currently written in Chinese): [docs/cli.md](docs/cli.md)

## License

MIT — free to use and modify. See [LICENSE](LICENSE).
