const express = require("express");
const http = require("http");
const cors = require("cors");
const {Server} = require("socket.io");
const fs = require("fs");
const axios = require("axios");


const app = express();

app.use(cors());

app.use(express.static("public"));



const server = http.createServer(app);



const io = new Server(server,{
cors:{
origin:"*"
}
});





// ======================
// DATABASE
// ======================


let database=[];


function loadDatabase(){


const files =
fs.readdirSync("./public/database");



files.forEach(file=>{


if(file.endsWith(".json")){


let category =
file.replace(".json","");



let data =
JSON.parse(
fs.readFileSync(
"./public/database/"+file
)
);



data.forEach(character=>{


database.push({

...character,

category

});


});

}


});


console.log(
database.length+
" personnages chargés"
);


}



loadDatabase();









// ======================
// IMAGE
// ======================


let imageCache={};



async function getImage(name){


if(imageCache[name])
return imageCache[name];



try{


let result =
await axios.get(

"https://api.jikan.moe/v4/characters",

{
params:{
q:name,
limit:1
}
}

);



if(result.data.data.length){


let url =
result.data.data[0]
.images
.jpg
.image_url;



imageCache[name]=url;


return url;


}


}

catch(e){}


return null;


}









// ======================
// ROOM
// ======================


let rooms={};



function codeRoom(){

return Math.random()
.toString(36)
.substring(2,8)
.toUpperCase();

}








function getPool(room){


let pool =
database.filter(c=>{


return (

room.settings.categories.includes("Tout")

||

room.settings.categories.includes(c.category)

)

&&

room.settings.difficulties.includes(c.difficulty);


});



return pool.length ? pool : database;


}









function randomCharacter(room){


let pool=getPool(room);


return pool[
Math.floor(
Math.random()*pool.length
)
];


}







function relatedCharacter(character){


let pool =
database.filter(c=>

c.category===character.category

&&

c.name!==character.name

);



return pool[
Math.floor(
Math.random()*pool.length
)
]
||
character;


}









function chooseImpostors(players,count){


return [...players]
.sort(
()=>Math.random()-0.5
)
.slice(0,count)
.map(p=>p.id);


}









function sendPlayers(roomCode){


io.to(roomCode)
.emit(
"players",
rooms[roomCode].players
);


}









// ======================
// SOCKET
// ======================


io.on(
"connection",
socket=>{






socket.on(
"createRoom",
data=>{


let code=codeRoom();



while(rooms[code])
code=codeRoom();



rooms[code]={


host:socket.id,


players:[

{
id:socket.id,
name:data.name,
score:0
}

],



settings:data,

round:0,

votes:{},

started:false


};




socket.join(code);



socket.emit(
"roomCreated",
{

code,

settings:data

}
);



sendPlayers(code);



});









socket.on(
"joinRoom",
data=>{


let room=rooms[data.code];


if(!room)

return;



room.players.push({

id:socket.id,

name:data.name,

score:0

});



socket.join(data.code);



socket.emit(
"joined",
{

code:data.code,

settings:room.settings

}
);



sendPlayers(data.code);



});









// ======================
// START GAME
// ======================


socket.on(
"startGame",
async code=>{


let room=rooms[code];


if(!room)
return;



room.round++;

room.votes={};



let main =
randomCharacter(room);



let fake =
relatedCharacter(main);



let impostors =
chooseImpostors(
room.players,
Number(room.settings.impostors)
);





for(let player of room.players){



let character;



if(impostors.includes(player.id)){


character=fake;


}

else{


character=main;


}




let image =
await getImage(character.name);




io.to(player.id)
.emit(
"card",
{

character:character.name,

image:image

}

);



}



io.to(code)
.emit(
"phase",
{

round:room.round,

time:room.settings.time

}

);



});









// ======================
// VOTE
// ======================


socket.on(
"vote",
data=>{


let room=rooms[data.code];


if(!room)
return;



room.votes[data.target]
=
(room.votes[data.target]||0)+1;



});









// ======================
// CHAT
// ======================


socket.on(
"chat",
data=>{


io.to(data.code)
.emit(
"chat",
data
);


});









// ======================
// NOUVELLE MANCHE
// ======================


socket.on(
"newGame",
code=>{


let room=rooms[code];


if(!room)
return;



room.votes={};



io.to(code)
.emit(
"phase",
{

round:room.round,

time:room.settings.time

}

);



});









socket.on(
"disconnect",
()=>{


for(let code in rooms){


rooms[code].players =
rooms[code].players.filter(
p=>p.id!==socket.id
);



sendPlayers(code);


}



});



});








server.listen(
3000,
()=>{

console.log(
"🎭 Anime Imposteur V10.1 lancé"
);

}
);