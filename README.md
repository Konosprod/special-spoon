# special-spoon

Discord bot to notify users if a new episode of their watching list has be released


## Installation

* Execute `yarn install` in the root directory to install dependencies.
* Create a new sqlite database, and use `db/schema.sql`to setup your tables.
* Edit the configuration file, set the bot token, and set the channel id where the bot will be posting.
* Launch the bot with `node index.js`.

## How to use

`!listwatch [Anilist Username]` Get into the watching loop
`!listdel`Get outside the watching loop

That's all folks