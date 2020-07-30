const Discord = require("discord.js")
const config = require("./config.json");
const winston = require("winston");
const needle = require("needle");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

var client = new Discord.Client({ partials: ['MESSAGE', 'REACTION'] });

const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.align(),
    winston.format.printf(({ level, message, label, timestamp }) => {
        return `${timestamp} [${label}] ${level}: ${message}`;
    })
);

const logger = winston.createLogger({
    level: config.level,
    format: logFormat,
    defaultMeta: {
        label: 'Herja'
    },
    transports: [
        new winston.transports.File({ filename: "./error.log", level: "error" }),
        new winston.transports.File({ filename: "./logl.log" }),
        new winston.transports.Console()
    ]
})


let db = new sqlite3.Database(config.database, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    
    if(err) {
        return logger.error(err);
    }
    db.run("PRAGMA foreign_keys = ON;", (err) => {
        if(err) {
            return logger.error(err);
        }
    })
    logger.info("Connected to the database")
});

client.on("message", message => {
    if(message.content.startsWith(`${config.prefix}listwatch`)) {
        var args = message.content.split(" ");
        if (args.length > 1) {
            logger.info("Add user " + message.author.username);
            getCurrentWatch(args[1], message.author.id)
            message.reply("Added to the system");
        }
    }

    if(message.content === `${config.prefix}listdel`) {
        logger.info("Remove users " + message.author.username);
        removeUser(message.author.id);
        message.reply("Removed from the system");
    }
})

client.once('ready', () => {
    logger.info("Ready");
    checkTimers();
    updateUsersAnime();
})

function createUser(username, uid, callback) {
    let sql = `INSERT INTO users(discordid, username) VALUES(?, ?)`;

    let stmt = db.prepare(sql);

    stmt.run([uid, username], err => {
        if(err) {
            logger.error(err);
        }

        callback(stmt.lastID);
    })
}

function getCurrentWatch(username, uid) {
    var query = `
        query($username: String){
            MediaListCollection(userName: $username type: ANIME status: CURRENT)
            {
                lists {
                    entries {
                        media {
                            id
                        }
                    }
                }
            }
        }
    `;

    var variables = {
        "username": username
    }

    var postOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
    }

    needle.post("https://graphql.anilist.co", { "query": query, "variables": variables }, postOptions, function (err, res) {
        if (err) {
            return logger.error(err);
        }

        var json = res.body;
        var ids = []

        json.data.MediaListCollection.lists[0].entries.forEach(val => {
            ids.push(val.media.id);
        });

        checkNextAired(username, ids, uid)
    })
}

function createAnime(val, callback) {
    
    let sql = `INSERT INTO anime(anilistid, timer, color, cover, title) VALUES(?, ?, ?, ?, ?)`;
    var nextEp = val.airingSchedule.nodes[0];
    var anilistid = val.id;
    var date = nextEp.airingAt
    var color = val.coverImage.color
    var cover = val.coverImage.extraLarge
    var title = val.title.romaji

    var stmt = db.prepare(sql)

    stmt.run([anilistid, date, color, cover, title], (err) => {
        if(err) {
            logger.error(err)
        }

        callback(stmt.lastID)
    })

}

function linkUserAnime(animeid, userid) {
    var sql = `INSERT INTO users_anime(user_id, anime_id) VALUES(?, ?)`;

    var existquery = db.prepare("SELECT * from users_anime where user_id = ? and anime_id = ?")

    existquery.get([userid, animeid], (err, row) => {
        if(err) {
            logger.error(err);
        }

        if(!row) {
            var stmt = db.prepare(sql);

            stmt.run([userid, animeid], (err) => {
                if(err) {
                    logger.error(err);
                }
            })
        }
    })
}

function updateTimers(json, sqlid, uid) {
    json.data.Page.media.forEach(val => {
        if (val.airingSchedule) {
            if (val.airingSchedule.nodes.length > 0) {
                var nextEp = val.airingSchedule.nodes[0];
                var anilistid = val.id;

                if (nextEp) {

                    var sql = 'SELECT * FROM anime WHERE anilistid = ?';

                    var stmt = db.prepare(sql);

                    stmt.get([anilistid], (err, row) => {
                        if (err) {
                            logger.error(err)
                        }

                        if (!row) {
                            createAnime(val, (animesqlid) => {
                                linkUserAnime(animesqlid, sqlid);
                            })
                        } else {
                            linkUserAnime(row.id, sqlid);
                        }
                    })
                }
            }
        }
    })
}

function deleteAnime(id) {
    var sql = "delete from anime where anime.anilistid = ?";

    var stmt = db.prepare(sql);

    stmt.run([id], (err) => {
        if(err) {
            logger.error(err);
        }
    })
}

function updateNextAired(id) {
    
    var sql = "update anime set timer = ? where anime.anilistid = ?"
    
    var query = `query($id: Int) {   
        Page {        
          pageInfo {            
            hasNextPage            
            total        
          }        
          media(
            sort:START_DATE, id:$id) {            
            id
            airingSchedule(    notYetAired: true    perPage: 2) 
            {    
              nodes {        
                episode        
                airingAt    
              }
            }        
          }    
        }
      }
    `;

    var variables = {
        id : id
    }

    var postOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
    }

    needle.post("https://graphql.anilist.co", { "query": query, "variables": variables }, postOptions, function (err, res) {
        if (err) {
            return logger.error(err);
        }

        var nodes = res.body.data.Page.media[0].airingSchedule.nodes

        if(nodes && nodes.length === 0) {
            deleteAnime(id);
        } else {
            var stmt = db.prepare(sql)
            
            var nextTimer = nodes[0].airingAt;

            stmt.run([nextTimer, id], (err) => {
                if(err) {
                    logger.error(err);
                }
            })
        }
    })
}

function checkNextAired(username, ids, uid) {

    var query = `query($ids: [Int]) {   
        Page {        
          pageInfo {            
            hasNextPage            
            total        
          }        
          media(
            sort:START_DATE, id_in:$ids) {            
            id
            title {    
              romaji    
            }

            siteUrl
            coverImage {    
              extraLarge    
              color
            }
            airingSchedule(    notYetAired: true    perPage: 2) 
            {    
              nodes {        
                episode        
                airingAt    
              }
            }        
          }    
        }
      }
    `;

    
    var variables = {
        ids: ids
    }

    var postOptions = {
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }
    }

    needle.post("https://graphql.anilist.co", { "query": query, "variables": variables }, postOptions, function (err, res) {
        if (err) {
            return logger.error(err);
        }

        var json = res.body;

        let sql = `
            SELECT * FROM users WHERE discordid = ?
        `;

        var stmt = db.prepare(sql, [uid]);

        stmt.get([uid], (err, row) => {
            
            if (err) {
                return logger.error(err);
            }

            if (!row) {
                createUser(username, uid, (sqlid) => {
                    updateTimers(json, sqlid);                    
                })
            } else {
                updateTimers(json, row.id);
            }
        })
    })

}

function notifyUsers(rows) {
    var mentionList = "";

    rows.forEach(row => {
        mentionList += "<@" + row.discordid + "> ";
    });

    var embed = new Discord.MessageEmbed()
        .setColor(rows[0].color)
        .setTitle(rows[0].title)
        .setURL("https://anilist.co/anime/" + rows[0].anilistid)
        .setDescription("New episode aired !")
        .setImage(rows[0].cover);
    
    client.channels.fetch(config.channelid).then(channel => {
        channel.send(mentionList, embed);
    }).catch((err) => {
        logger.error(err);
    })
    
}

function checkTimers() {

    var sqlanimeids = `select id from anime`
    var sqltusers = `select timer, anilistid, discordid, color, cover, title
    from users_anime as ua
    join anime as a on ua.anime_id = a.id
    join users as u on ua.user_id = u.id
    where a.id = ?`

    var stmt = db.prepare(sqlanimeids)

    stmt.all((err, rows) => {
        if(err) {
            logger.error(err);
        }

        rows.forEach(row => {
            let usersquery = db.prepare(sqltusers);

            usersquery.all([row.id], (err, rows) => {
                if(err) {
                    logger.error(err);
                }

                if(rows && rows.length > 0) {
                    if(rows[0].timer*1000 <= new Date().getTime()) {
                        notifyUsers(rows);
                        updateNextAired(rows[0].anilistid);
                    }
                }
            })
        });
    })
}


function checkDatabase() {
    const dataSql = fs.readFileSync('./db/schema.sql').toString();
    const dataArr = dataSql.toString().split(';');

    dataArr.forEach(query => {
        db.run(query, (err) => {
            if(err) {
                logger.error(err);
            }
        })
    });
}

function removeUser(discordid) {
    var sql = "DELETE FROM users WHERE users.discordid = ?";

    var stmt = db.prepare(sql);

    stmt.run([discordid], (err) => {
        if(err) {
            logger.error(err);
        }
    })
}

function updateUsersAnime() {
    var sql = "select username, discordid from users";

    var usersquery = db.prepare(sql);

    usersquery.all((err, rows) => {
        if(err) {
            return logger.error(err);
        }

        rows.forEach(user => {
            if (user) {
                getCurrentWatch(user.username, user.discordid);
            }
        });
    })
}

//Check everyhour
setInterval(checkTimers, 60*1000*60)

//Check new anime from users every 3 hours
setInterval(updateUsersAnime, 60*1000*60*3);

client.login(config.token);

