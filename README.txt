Apollo's Temple site files
====================

public/index.html            The site itself. This is what visitors load, at every address: apolloncc.org/hr,
                             /bar, /settings, /staff/<someone> and so on (since v2.18 every page has its own address).
public/embed.html            One person's About box on its own, for a Carrd (apolloncc.org/embed/<their id>). Get the
                             code to paste from their profile: Copy Carrd embed code. On the Carrd, add an Embed
                             element, Type: Code, Style: Inline, and paste it in. The box sizes itself to fit and
                             updates whenever they edit their About on the site.
public/manifest.webmanifest  Lets phones install the site as an app (name, colours, icons).
public/sw.js                 Small helper the installed app needs; it also lets the app open with no connection.
public/icons/                The app icons.
public/stars.gif             The sparkling starry background (dark theme). stars-still.png is one still frame of it,
                             shown to people whose device asks for less motion.
firestore.rules              The access rules the database enforces (who can read and change what).
                             The owner login is already set to your User UID.
storage.rules                Who can add and see the files kept in storage: the pictures and videos for Hermes' event
                             posts (owners only), and since v2.16 the profile pictures that move and the full-body
                             pictures on Staff Profiles and Mortal Profiles (each person their own; anyone can see them).
firebase.json                Tells Firebase to publish the "public" folder, the rules and the functions, and to
                             answer every address with the site (and /embed/ addresses with embed.html).
.firebaserc                  Points these files at the ApolloHR project (apollohr-9b84f).
functions/                   The jobs Firebase runs by itself (needs the Blaze plan):
                               - Hermes delivering each new application to Discord (hermes.js has his wording)
                               - Hermes the bot posting each Calendar event: the 10 AM announcement and the
                                 doors-open post (eventposts.js), talking to Discord (discordbot.js)
                               - listAccounts: everyone with an account, for Account management (index.js)
                               - Hermes' slash commands: /clockin, /clockout, /shift, /onshift, /hrlink (clock.js);
                                 defaults.json is the site's starting settings, for his pay sums (made by build.py)
                             index.js lists them all.
BOT-SETUP.txt                Making Hermes the bot, step by step. Do this once, before the first deploy with him.
apollo-data.json             The ledger as it was when the site launched, as a backup file.
                             It is NOT published. Do not load it again unless you mean to go back to that data.

Publishing (from a terminal opened in this folder)
--------------------------------------------------
  firebase deploy

This publishes the site, the database and storage rules, and the functions together. Before deploying the functions, it
installs what they need into functions/node_modules (that folder is never uploaded or published).

The first deploy with the functions
  1. Update the Firebase tools first:   npm install -g firebase-tools
  2. Run firebase deploy. It switches on a few Google Cloud services for the project and takes several minutes.
     - If it asks how many days to keep container images, press Enter.
     - If it says to try again in a few minutes (Google is still setting up the new plan), wait a few minutes
       and run firebase deploy again.
  3. In the site, go to Settings > Discord, paste the Hermes webhook, and click Send a test message.

The first deploy with Hermes the bot
  Follow BOT-SETUP.txt. In short: make the bot in Discord, switch on Storage in the Firebase console, run
  firebase functions:secrets:set DISCORD_BOT_TOKEN and paste his token, then firebase deploy (say y to the
  storage role it asks about), and invite him from Settings > Discord on the site.

If a deploy stops with "User code failed to load ... Timeout after 10000"
  The deploy gives the functions 10 seconds to load on your computer, and a folder kept in OneDrive can be slower
  than that. Give it a minute instead, once, then open a new terminal and deploy again:
      setx FUNCTIONS_DISCOVERY_TIMEOUT 60
  (For just the terminal you have open: $env:FUNCTIONS_DISCOVERY_TIMEOUT=60)

Installing the app on a phone
-----------------------------
Open https://apolloncc.org in Chrome, then use "Install the app" on the Home page,
or Chrome's menu > "Add to Home screen" > Install.
