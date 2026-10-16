# WANTED: your own game server

This folder is the whole game plus a small server for live duels. Anyone with the link can play, no Claude account needed.

What's inside:

| File | What it does |
|---|---|
| `server.js` | The game server: shows the game, runs the live lobby and Duel Zone, keeps names unique, knows who the owner is |
| `public/index.html` | The game itself |
| `connector.js` | The piece that links the game to the server (already built into `index.html`; kept here for reference) |
| `package.json` | Tells the host how to start the server |

Nothing needs installing: the server uses only what comes with Node.js.

## Put it online for free (Render)

You need a free **GitHub** account and a free **Render** account. Check that you meet each site's age rules, and ask a parent if you're not sure.

### 1. Put the files on GitHub
1. Sign in at github.com and click **New repository**. Name it `wanted-game`, keep it **Public** or **Private**, and click **Create repository**.
2. Click **uploading an existing file**.
3. Drag in `server.js`, `package.json`, `README.md`, `.gitignore`, and the whole `public` folder (with `index.html` inside it).
4. Click **Commit changes**.

### 2. Start the server on Render
1. Sign in at render.com (you can sign in with GitHub).
2. Click **New** → **Web Service**, and pick your `wanted-game` repository.
3. Fill in:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Under **Environment variables**, add one:
   - **Key:** `ADMIN_PASSWORD`
   - **Value:** a password only you know (this is what makes you the owner)
5. Click **Create Web Service**. After a minute or two you'll get a link like `https://wanted-game.onrender.com`.

### 3. Become the owner
Open your link once with your password on the end:

```
https://wanted-game.onrender.com/?admin=YOUR_PASSWORD
```

The game remembers it on that browser and removes it from the address bar. Now you get unlimited keys, the admin panel (press **K**), the Enargade skin, and only you can take the name **judahpro5555**. To log out on a shared computer, open the link with `?logout` on the end.

Never send anyone the link with your password in it. Send friends the plain link.

### 4. Play with friends
Send them the plain link. Everyone who has it open at the same time shows up in the lobby, and anyone inside the Duel Zone can fight.

## Good to know about the free plan

- **It falls asleep.** After 15 minutes with nobody connected, Render pauses the server. The next person to open the link waits about a minute while it wakes up. While people are playing, it stays awake.
- **Names reset sometimes.** Claimed names are saved in a file that Render clears when the server restarts, redeploys or falls asleep. Players just pick their name again. Keys, weapons and skins are saved in each player's own browser, so those stay.
- **750 free hours a month** per Render account, which is enough to run one game all month.

## Changing the game later

Edit `public/index.html` on GitHub (or upload a new one). Render notices the change and restarts with the new version in a couple of minutes.

## Before you share it publicly

The Magma, Neon Grid and Enargade skins use pictures with stock-photo watermarks. That's fine for a game with friends, but swap them out for your own pictures before posting the game anywhere public.
