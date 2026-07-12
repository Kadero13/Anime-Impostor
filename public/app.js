const socket = io();


let currentRoom = "";
let username = localStorage.getItem("animeImposteurName") || "";
let isHost = false;
let myCard = null;
let roomSettings = {};
let timerInterval = "";





// =========================
// Chargement pseudo
// =========================

window.onload = () => {

    if(username){
        document.getElementById("username").value = username;
    }

};





function saveName(){

    username =
    document.getElementById("username").value.trim();


    localStorage.setItem(
        "animeImposteurName",
        username
    );

}





// =========================
// Options
// =========================


function getCategories(){

    return [
        ...document.querySelectorAll(".category:checked")
    ]
    .map(x=>x.value);

}



function getDifficulties(){

    return [
        ...document.querySelectorAll(".difficulty:checked")
    ]
    .map(x=>x.value);

}







// =========================
// Créer partie
// =========================


function createRoom(){

    saveName();


    if(!username){

        alert("Entre un pseudo");

        return;

    }


    socket.emit(
        "createRoom",
        {

            name:username,

            categories:getCategories(),

            difficulties:getDifficulties(),

            time:Number(
                document.getElementById("time").value
            ),

            impostors:Number(
                document.getElementById("impostors").value
            )

        }
    );

}







// =========================
// Rejoindre
// =========================


function joinRoom(){

    saveName();


    let code =
    document.getElementById("roomCode")
    .value
    .toUpperCase();



    socket.emit(
        "joinRoom",
        {

            name:username,

            code:code

        }
    );

}









// =========================
// Ouverture jeu
// =========================


socket.on(
"roomCreated",
data=>{

    currentRoom=data.code;

    roomSettings=data.settings;

    isHost=true;

    openGame();

});


socket.on(
"joined",
data=>{

    currentRoom=data.code;

    roomSettings=data.settings;

    openGame();

});






function openGame(){

    document.getElementById("login")
    .style.display="none";


    document.getElementById("game")
    .style.display="block";


    document.getElementById("roomCodeDisplay")
    .innerHTML=currentRoom;


    displaySettings();



    if(!isHost){

        document.getElementById("startButton")
        .style.display="none";

    }

}






function displaySettings(){


    document.getElementById("settingsDisplay")
    .innerHTML=
    
    `
    🌍 ${roomSettings.categories.join(",")}
    <br>
    🔥 ${roomSettings.difficulties.join(",")}
    <br>
    ⏱ ${roomSettings.time}s
    <br>
    🎭 ${roomSettings.impostors} imposteur(s)
    `;

}







// =========================
// Copier code
// =========================


function copyRoom(){

    navigator.clipboard.writeText(currentRoom);

    alert("Code copié : "+currentRoom);

}







// =========================
// Joueurs
// =========================


socket.on(
"players",
players=>{


    let list =
    document.getElementById("players");


    list.innerHTML="";


    document.getElementById("playerCount")
    .innerHTML=
    "👥 Joueurs : "+players.length;



    players.forEach(player=>{


        let li =
        document.createElement("li");


        li.innerHTML =
        player.name+
        " ⭐ "+
        player.score;


        list.appendChild(li);


    });


});









// =========================
// Lancer
// =========================


function startGame(){

    socket.emit(
        "startGame",
        currentRoom
    );

}









// =========================
// Carte
// =========================


socket.on(
"card",
card=>{


    myCard=card;


    document.getElementById("card")
    .innerHTML=
    "🎴 Clique pour révéler";


    let img =
    document.getElementById("characterImage");


    img.style.display="none";


});






function revealCard(){


    if(!myCard)

    return;



    document.getElementById("card")
    .innerHTML=

    `
    🎭
    <br><br>
    <b>${myCard.character}</b>
    `;



    if(myCard.image){


        let img =
        document.getElementById("characterImage");



        img.src=myCard.image;



        img.onload=()=>{

            img.style.display="block";

        };



        img.onerror=()=>{

            img.style.display="none";

        };


    }


}









// =========================
// Manche
// =========================


socket.on(
"phase",
data=>{


    document.getElementById("round")
    .innerHTML=data.round;



    document.getElementById("phase")
    .innerHTML="💬 Discussion";



    startTimer(data.time);


});








function startTimer(time){


    clearInterval(timerInterval);



    timerInterval=setInterval(()=>{


        document.getElementById("timer")
        .innerHTML=
        "⏳ "+time+"s";


        time--;



        if(time<0){


            clearInterval(timerInterval);


            document.getElementById("timer")
            .innerHTML="🗳 Vote";


        }



    },1000);


}








// =========================
// Chat
// =========================


function sendChat(){


    let input =
    document.getElementById("chatInput");


    if(!input.value.trim())

    return;



    socket.emit(
        "chat",
        {

            code:currentRoom,

            name:username,

            message:input.value

        }
    );


    input.value="";


}






socket.on(
"chat",
data=>{


    let box =
    document.getElementById("messages");


    let p =
    document.createElement("p");


    p.innerHTML =
    "<b>"+
    data.name+
    "</b> : "+
    data.message;


    box.appendChild(p);


});








// =========================
// Vote
// =========================


socket.on(
"players",
players=>{


    let select =
    document.getElementById("voteList");


    select.innerHTML="";



    players.forEach(p=>{


        let option =
        document.createElement("option");


        option.value=p.id;

        option.textContent=p.name;


        select.appendChild(option);


    });


});





function vote(){


    socket.emit(
        "vote",
        {

            code:currentRoom,

            target:
            document.getElementById("voteList")
            .value

        }
    );


}








// =========================
// Résultat
// =========================


socket.on(
"result",
data=>{


    document.getElementById("result")
    .innerHTML=

    data.win
    ?
    "🎉 Les joueurs gagnent"
    :
    "☠️ Les imposteurs gagnent";



});








function newRound(){


    socket.emit(
        "newGame",
        currentRoom
    );


}








// =========================
// Erreurs
// =========================


socket.on(
"error",
msg=>{

    alert(msg);

});