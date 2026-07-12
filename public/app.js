const socket = io();


let currentRoom = "";
let username = localStorage.getItem("animeImposteurName") || "";
let isHost = false;
let myCard = null;
let roomSettings = {};
let timerInterval = "";
let alreadyVoted = false;



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





function getCategories(){

    return [
        ...document.querySelectorAll(".category:checked")
    ].map(x=>x.value);

}





function getDifficulties(){

    return [
        ...document.querySelectorAll(".difficulty:checked")
    ].map(x=>x.value);

}








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







function copyRoom(){

    navigator.clipboard.writeText(currentRoom);

    alert("Code copié : "+currentRoom);

}








socket.on(
"players",
players=>{


    let list =
    document.getElementById("players");


    list.innerHTML="";


    document.getElementById("playerCount")
    .innerHTML=
    "👥 Joueurs : "+players.length;




    let select =
    document.getElementById("voteList");


    select.innerHTML="";





    players.forEach(player=>{


        let li =
        document.createElement("li");


        li.innerHTML =
        player.name+
        " ⭐ "+
        player.score;


        list.appendChild(li);





        if(player.id !== socket.id){


            let option =
            document.createElement("option");


            option.value=player.id;

            option.textContent=player.name;


            select.appendChild(option);


        }



    });



    let skip =
    document.createElement("option");


    skip.value="skip";

    skip.textContent="⏭ Personne";

    select.appendChild(skip);



});









function startGame(){

    socket.emit(
        "startGame",
        currentRoom
    );

}









socket.on(
"card",
card=>{


    myCard=card;


    document.getElementById("card")
    .innerHTML=
    "🎴 Clique pour révéler";


    document.getElementById("characterImage")
    .style.display="none";


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


    }

}








socket.on(
"phase",
data=>{


    document.getElementById("round")
    .innerHTML=data.round;


    document.getElementById("phase")
    .innerHTML="💬 Discussion";


    alreadyVoted=false;


    document.getElementById("voteList").disabled=false;


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









function vote(){


    if(alreadyVoted){

        alert("Tu as déjà voté");

        return;

    }



    let target =
    document.getElementById("voteList").value;



    socket.emit(
        "vote",
        {

            code:currentRoom,

            target:target

        }
    );



    alreadyVoted=true;


    document.getElementById("voteList")
    .disabled=true;



}







function skipVote(){


    if(alreadyVoted)
    return;



    socket.emit(
        "vote",
        {

            code:currentRoom,

            target:"skip"

        }
    );



    alreadyVoted=true;


}









socket.on(
"voteResult",
data=>{


    if(data.eliminated){


        document.getElementById("result")
        .innerHTML=

        "🗳 Joueur éliminé : "
        +
        data.eliminated;


    }
    else{


        document.getElementById("result")
        .innerHTML=
        "⏭ Personne n'est éliminé";


    }


});









function newRound(){


    socket.emit(
        "newGame",
        currentRoom
    );

}







socket.on(
"error",
msg=>{

    alert(msg);

});