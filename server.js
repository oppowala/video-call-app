require("dotenv").config();
const express = require("express");
const path = require("path");
const app = express();
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server().listen(server);
const ngrok = require("ngrok");

var PORT = process.env.PORT || 3000; // signalingServerPort
var localHost = "http://localhost:" + PORT; // http
var channels = {}; // collect channels
var sockets = {}; // collect sockets
var peers = {}; // collect peers info grp by channels

var ngrokEnabled = process.env.NGROK_ENABLED;
var ngrokAuthToken = process.env.NGROK_AUTH_TOKEN;
var turnEnabled = process.env.TURN_ENABLED;
var turnUrls = process.env.TURN_URLS;
var turnUsername = process.env.TURN_USERNAME;
var turnCredential = process.env.TURN_PASSWORD;

// Use all static files from the www folder
app.use(express.static(path.join(__dirname, "www")));

// Remove trailing slashes in url
app.use(function (req, res, next) {
  if (req.path.substr(-1) === "/" && req.path.length > 1) {
    let query = req.url.slice(req.path.length);
    res.redirect(301, req.path.slice(0, -1) + query);
  } else {
    next();
  }
});

// no room name specified to join
app.get("/join/", function (req, res) {
  res.redirect("/");
});

app.get("/", function (req, res) {
  res.redirect("index.html");
});

// join to room
app.get("/join/*", function (req, res) {
  if (Object.keys(req.query).length > 0) {
    console.log("redirect:" + req.url + " to " + url.parse(req.url).pathname);
    res.redirect(url.parse(req.url).pathname);
  } else {
    res.sendFile(path.join(__dirname, "www/client.html"));
  }
});

var iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

if (turnEnabled == "true") {
  iceServers.push({
    urls: turnUrls,
    username: turnUsername,
    credential: turnCredential,
  });
}

/**
 * Expose server to external with https tunnel using ngrok
 * https://ngrok.com
 */
async function ngrokStart() {
  try {
    await ngrok.authtoken(ngrokAuthToken);
    await ngrok.connect(PORT);
    let api = ngrok.getApi();
    let data = await api.get("api/tunnels");
    data = JSON.parse(data);
    // console.log(data);
    let pu0 = data.tunnels[0].public_url;
    let pu1 = data.tunnels[1].public_url;
    let tunnelHttps = pu0.startsWith("https") ? pu0 : pu1;
    // server settings
    console.log("settings", {
      http: localHost,
      https: tunnelHttps,
      iceServers: iceServers,
      ngrok: {
        ngrok_enabled: ngrokEnabled,
        ngrok_token: ngrokAuthToken,
      },
    });
  } catch (e) {
    console.error("[Error] ngrokStart", e);
  }
}

/**
 * Start Local Server with ngrok https tunnel (optional)
 */
server.listen(PORT, null, function () {

});

io.sockets.on("connect", (socket) => {
  console.log("[" + socket.id + "] --> connection accepted");

  socket.channels = {};
  sockets[socket.id] = socket;

  socket.on("disconnect", () => {
    for (var channel in socket.channels) {
      removePeerFrom(channel);
    }
    console.log("[" + socket.id + "] <--> disconnected");
    delete sockets[socket.id];
  });

  /**
   * On peer join
   */
  socket.on("join", (config) => {
    console.log("[" + socket.id + "] --> join ", config);

    var channel = config.channel;
    var peer_name = config.peerName;
    var peer_video = config.peerVideo;
    var peer_audio = config.peerAudio;
    var peer_hand = config.peerHand;

    if (channel in socket.channels) {
      console.log("[" + socket.id + "] [Warning] already joined", channel);
      return;
    }
    // no channel aka room in channels init
    if (!(channel in channels)) {
      channels[channel] = {};
    }

    // no channel aka room in peers init
    if (!(channel in peers)) {
      peers[channel] = {};
    }

    // collect peers info grp by channels
    peers[channel][socket.id] = {
      peer_name: peer_name,
      peer_video: peer_video,
      peer_audio: peer_audio,
      peer_hand: peer_hand,
    };
    console.log("connected peers grp by roomId", peers);

    for (var id in channels[channel]) {
      // offer false
      channels[channel][id].emit("addPeer", {
        peer_id: socket.id,
        peers: peers[channel],
        should_create_offer: false,
        iceServers: iceServers,
      });
      // offer true
      socket.emit("addPeer", {
        peer_id: id,
        peers: peers[channel],
        should_create_offer: true,
        iceServers: iceServers,
      });
      console.log("[" + socket.id + "] emit add Peer [" + id + "]");
    }

    channels[channel][socket.id] = socket;
    socket.channels[channel] = channel;
  });

  /**
   * Remove peers from channel aka room
   * @param {*} channel
   */
  async function removePeerFrom(channel) {
    if (!(channel in socket.channels)) {
      console.log("[" + socket.id + "] [Warning] not in ", channel);
      return;
    }

    delete socket.channels[channel];
    delete channels[channel][socket.id];
    delete peers[channel][socket.id];

    // if not channel aka room in peers remove it
    if (Object.keys(peers[channel]).length === 0) {
      delete peers[channel];
    }

    for (var id in channels[channel]) {
      await channels[channel][id].emit("removePeer", { peer_id: socket.id });
      await socket.emit("removePeer", { peer_id: id });
      console.log("[" + socket.id + "] emit remove Peer [" + id + "]");
    }
  }

  /**
   * Relay ICE to peers
   */
  socket.on("relayICE", (config) => {
    let peer_id = config.peer_id;
    let ice_candidate = config.ice_candidate;
    /*
    console.log(
      "[" + socket.id + "] relay ICE-candidate to [" + peer_id + "] ",
      { address: config.ice_candidate.address }
    ); // ice_candidate
    */
    if (peer_id in sockets) {
      sockets[peer_id].emit("iceCandidate", {
        peer_id: socket.id,
        ice_candidate: ice_candidate,
      });
    }
  });

  /**
   * Relay SDP to peers
   */
  socket.on("relaySDP", (config) => {
    let peer_id = config.peer_id;
    let session_description = config.session_description;

    console.log(
      "[" + socket.id + "] relay SessionDescription to [" + peer_id + "] ",
      { type: session_description.type }
    ); // session_description

    if (peer_id in sockets) {
      sockets[peer_id].emit("sessionDescription", {
        peer_id: socket.id,
        session_description: session_description,
      });
    }
  });

  /**
   * Relay MSG to peers
   */
  socket.on("msg", (config) => {
    let peerConnections = config.peerConnections;
    let room_id = config.room_id;
    let privateMsg = config.privateMsg;
    let id = config.peer_id;
    let name = config.name;
    let msg = config.msg;

    console.log(
      "[" +
        socket.id +
        "] emit onMessage to [room_id: " +
        room_id +
        " private_msg: " +
        privateMsg +
        "]",
      {
        name: name,
        msg: msg,
      }
    );

    if (privateMsg) {
      if (sockets[id]) {
        sockets[id].emit("onMessage", {
          peer_id: socket.id,
          privateMsg: privateMsg,
          name: name,
          msg: msg,
        });
      }
      return;
    }

    for (var peer_id in peerConnections) {
      if (sockets[peer_id]) {
        sockets[peer_id].emit("onMessage", {
          peer_id: socket.id,
          privateMsg: privateMsg,
          name: name,
          msg: msg,
        });
      }
    }
  });

  socket.on("cName", (config) => {
    let peerConnections = config.peerConnections;
    let room_id = config.room_id;
    let peer_name_old = config.peer_name_old;
    let peer_name_new = config.peer_name_new;
    let peer_id_to_update = null;

    // update peers new name in the specified room
    for (var peer_id in peers[room_id]) {
      if (peers[room_id][peer_id]["peer_name"] == peer_name_old) {
        peers[room_id][peer_id]["peer_name"] = peer_name_new;
        peer_id_to_update = peer_id;

      }
    }

    if (peer_id_to_update && Object.keys(peerConnections).length != 0) {
      console.log(
        "[" + socket.id + "] emit onCName to [room_id: " + room_id + "]",
        {
          peer_id: peer_id_to_update,
          peer_name: peer_name_new,
        }
      );
      for (var peer_id in peerConnections) {
        if (sockets[peer_id]) {
          sockets[peer_id].emit("onCName", {
            peer_id: peer_id_to_update,
            peer_name: peer_name_new,
          });
        }
      }
    }
  });


  socket.on("peerStatus", (config) => {
    let peerConnections = config.peerConnections;
    let room_id = config.room_id;
    let peer_name = config.peer_name;
    let element = config.element;
    let status = config.status;

    for (var peer_id in peers[room_id]) {
      if (peers[room_id][peer_id]["peer_name"] == peer_name) {
        switch (element) {
          case "video":
            peers[room_id][peer_id]["peer_video"] = status;
            break;
          case "audio":
            peers[room_id][peer_id]["peer_audio"] = status;
            break;
          case "hand":
            peers[room_id][peer_id]["peer_hand"] = status;
            break;
        }
  
      }
    }

    // socket.id aka peer that send this status
    if (Object.keys(peerConnections).length != 0) {
      console.log(
        "[" + socket.id + "] emit onpeerStatus to [room_id: " + room_id + "]",
        {
          peer_id: socket.id,
          element: element,
          status: status,
        }
      );
      for (var peer_id in peerConnections) {
        if (sockets[peer_id]) {
          sockets[peer_id].emit("onpeerStatus", {
            peer_id: socket.id,
            element: element,
            status: status,
          });
        }
      }
    }
  });

});