# The bot's computer

Every bot has a real computer with a browser, a terminal, files and a desktop, so it can do work
that needs more than a chat.

## Watch it work

On web and desktop, select the bot's name at the top of its chat and find **Computer** in the bot
panel. The preview shows the running screen beside the chat. Choose **Open** on the preview for a
full-window view, or **Wake** if the computer is asleep. The computer also starts when the bot needs
it and goes to sleep when idle. In the full-window view, choose **Save screenshot** to download a
picture of what the screen shows right now, such as a code or an error you want to keep.

On mobile, tap the bot's name at the top of its chat to open its profile, then tap **Computer**.

## Take control

Choose **Take control** to use the screen yourself, for example to answer a CAPTCHA, enter a code
texted to your phone, or work through an ordinary site. The header shows **You have control** until
you choose **Release control** (**Release** on mobile). Take control drives the bot's automated
browser, which Google refuses for sign-in; Google has its own steps below.

When the bot hits something only you can do, such as a CAPTCHA or a code texted to your phone, it
asks you to take over. The header shows **Needs you**. Do the step, then choose **I’m done**, or
**Skip** to let the bot carry on without it.

> [!TIP]
> Want the bot to sign in by itself next time? Ask it to save the login. See
> [Reusable credentials](./bot-secrets.md). This does not apply to Google, which refuses the bot's
> automated browser; see [Sign in to Google](#sign-in-to-google).

## Sign in to Google

Google refuses a sign-in from the bot's automated browser, so Take control and the page tools cannot
sign in to Google. On a self-hosted Linux install that runs the stack with `scripts/native`, do this
once, in order, from a terminal in the host's desktop session:

1. Run `bash scripts/native/install-chrome.sh`. It installs the real Google Chrome, not Chrome for
   Testing. Run it again later only if it reports that no accepted Chrome is installed.
2. Run `bash scripts/native/browser-login.sh`. It stops the shared browser, then opens an ordinary
   Google Chrome window on the same profile with a tab at `accounts.google.com`, no headless mode
   and no debugging port.
3. Sign in to Google in that window and wait until your account appears.
4. Close the whole window. The script then checks the profile for Google session cookies, prints how
   many it found (never their values), and restarts the shared browser on the same profile so the
   bots keep the session.

While the window is open the bots have no browser. The wait is bounded (30 minutes by default;
`--wait-minutes N` or `RAKAZO_NATIVE_LOGIN_WAIT_MINUTES` changes it), so an unfinished sign-in
returns the browser to the bots instead of leaving the stack without one. Exit codes: `2` a
prerequisite is missing (no Chrome, no graphical session, `sqlite3`, the shared browser did not
stop), `3` no Google session was created or Google refused the browser (also when the session could
not be verified, or the window stayed open past the wait), `4` Chrome failed to start or close.
Retrying the same window after a refusal does not help: install the real Google Chrome once with
`install-chrome.sh`, then run the sign-in again.

Two things follow a successful sign-in, and both are expected:

- **browse disconnects.** The script restarts the shared browser on the real Google Chrome it signed
  in with, and branded Chrome ignores `--load-extension`, so on a host that uses the `browse` MCP
  server its extension does not connect. The Google session stays in the profile. To bring browse
  back, stop the shared browser and start it again (`bash scripts/native/browser-stop.sh`, then
  `bash scripts/native/browser.sh`), which returns to the browser in `.env`; restarting the stack
  alone leaves the running browser in place.
- **A reboot starts headless.** In the 24/7 user service the graphical session is not carried across
  a reboot, so the shared browser starts headless. The Google session in the profile remains, but a
  new Google sign-in needs a desktop session: run `browser-login.sh` there again.

**What the bot never does.** The bot is instructed never to open `accounts.google.com` with Take
control or the page tools, and never to try to sign in to Google itself. With the built-in page tools
(`browser_navigate`, `browser_act`) the page browser also refuses those commands before it touches a
tab. When pages go through the `browse` MCP server (Playwright), that server cannot inspect the page
code, so there the instruction is the guard rather than a code check. If the bot sees "This browser
or app may not be secure" or a refused-sign-in page, it stops and asks you to run the steps above; it
never retries. It never asks for your Google password in the chat. On any other computer it uses
OAuth instead.

Containers, hosted computers and the macOS and Windows desktop apps have no such window; there,
connect the Google app in [Integrations](./integrations.md) and use OAuth instead.

## Team or Private

In the bot's settings under **Advanced**, **Computer** is **Team** or **Private**.

- **Team** (the default): bots in the [space](./spaces.md) share one Team Computer, with the same
  files and installed tools. Each bot gets its own screen and browser, and sites you sign in to are
  carried over to the other bots.
- **Private**: the bot gets a computer of its own. Use it when files or sign-ins must not be shared
  with other bots.

## Files

Bots save their work on the computer and send you the results as files in the chat. Every file a bot
has sent is also under **Artifacts** in the account menu.

To have a bot react to files changing, use a [routine](./routines.md) that watches a folder.

## Fix a computer

On web and desktop, open the bot's computer. If the screen cannot connect, try **Retry screen**.
If a repair is available, its button appears with the error.

On mobile, open the bot's profile and choose **Edit**, then **Advanced**. A repair action appears
when the computer is in an error state.

- **Recover computer** rebuilds the computer and restores the last saved workspace. Unsaved work may be lost.
- **Reset computer** restores the last saved workspace. Unsaved work is lost.

## Use your own computer

In the [desktop app](./desktop-app.md), bots can also run commands and use apps on the computer the
app is installed on. Turn on **Let bots use this computer** in **Settings → Computers** under
**Your devices**. This works with Rakazo Cloud, an HTTPS server you connect to, and a
loopback server.
Using apps on screen works on Mac and Windows; on a Mac, allow Rakazo under **Accessibility** and
**Screen Recording** in System Settings.

In every [approval mode](./approvals.md), a bot asks before it first uses each app in a space, and
on a connected server before its first command there too, unless a Block rule refuses it. **Allow
in this space** covers the rest of that space, in any chat. Bots use your apps only in chats you
start with your own bots, never from routines or other people's messages.

> [!WARNING]
> A bot with access to your computer can read your files and run programs as you. Only turn it on
> for a computer you would let your bots use unattended.
