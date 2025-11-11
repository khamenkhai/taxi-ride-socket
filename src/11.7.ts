import express from "express";
import http from "http";
import { Server } from "socket.io";
import admin from "firebase-admin";
import { serviceAccount } from "./secrets";


// Map<rideRequestId, NodeJS.Timeout>
const pendingRideRequests: Map<string, NodeJS.Timeout> = new Map();

console.log("🔥 Initializing Firebase Admin...");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin initialized.");

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log("🌐 Socket.IO Server and CORS configured.");

const ridesCollection = db.collection("rides");
console.log("📚 Firestore collections referenced.");

// ===========================================================
// 🔌 Socket Connection Handler
// ===========================================================
io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // When client provides their userId and type after reconnect
  socket.on(
    "user:reconnect",
    (data: { userId: string; type: "rider" | "driver" }) => {
      console.log(`🔄 User reconnect event:`, data);
    }
  );

  // ===========================================================
  // ✅ User joins their respective room
  // ===========================================================
  socket.on(
    "user:join",
    (data: { userId: string; type: "rider" | "driver" }) => {
      console.log(`👤 ${data.type} is attempting to join room: ${data.userId}`);
      socket.join(data.userId);
      console.log(`🚪 Joined user room: ${data.userId}`);

      if (data.type === "driver") {
        socket.join("drivers");
        console.log("🚕 Driver also joined 'drivers' room.");
      }
      console.log(`✅ ${data.type} joined successfully.`);
    }
  );

  socket.on("ride:request", async (rideRequestData) => {
    console.log(`📲 New ride request received from rider:`, rideRequestData);

    const rideRequestId = rideRequestData.rideRequestId;

    try {
      // Get all online drivers
      const snapshot = await db
        .collection("drivers")
        .where("online", "==", true)
        .get();

      if (!snapshot.empty) {
        snapshot.docs.forEach((doc) => {
          const driverSocketId = doc.data().socketId;
          if (driverSocketId) {
            io.to(driverSocketId).emit("ride:requested", rideRequestData);
            console.log(`📡 Ride request sent to driver ${doc.id}`);
          }
        });

        // Start 10-second timeout for this ride request
        const timer = setTimeout(async () => {
          console.log(`⏰ Ride request ${rideRequestId} timed out!`);

          // Notify rider or handle fallback logic
          io.to(rideRequestData.riderId).emit("ride:timeout", {
            rideRequestId,
            message: "No driver accepted in time",
          });

          pendingRideRequests.delete(rideRequestId);
        }, 200000); // 10 seconds

        pendingRideRequests.set(rideRequestId, timer);
      } else {
        console.log("⚠️ No online drivers found for this ride request");
      }
    } catch (error) {
      console.error("❌ Error sending ride request to online drivers:", error);
    }
  });

  // ===========================================================
  // ✅ Driver accepts ride
  // ===========================================================
  socket.on(
    "ride:accept",
    async (data: {
      rideRequestId: string;
      rideId: string;
      driverLocation: { lat: number; lng: number };
      driverId: string;
      riderId: string;
    }) => {
      try {
        console.log("💚 Ride ACCEPT event received");
        console.log("🔍 Full payload:", JSON.stringify(data, null, 2));

        // 1️⃣ Driver joins the ride room
        console.log(`🔗 Driver joining ride room: ${data.rideId}`);
        socket.join(data.rideId);
        console.log(
          `🚗 Driver socket ${socket.id} joined room: ${data.rideId}`
        );

        // 2️⃣ Log current room memberships
        const driverRoomSockets = await io.in(data.driverId).allSockets();
        const rideRoomSockets = await io.in(data.rideId).allSockets();
        console.log(
          `🟢 Sockets in driverId room (${data.driverId}):`,
          driverRoomSockets
        );
        console.log(
          `🟢 Sockets in ride room (${data.rideId}):`,
          rideRoomSockets
        );

        // 3️⃣ Notify rider and driver
        const acceptedPayload = {
          rideId: data.rideId,
          driverLocation: data.driverLocation,
        };

        console.log(
          `✉️ Sending 'ride:accepted' to rider room: ${data.riderId}`
        );
        io.to(data.riderId).emit("ride:accepted", acceptedPayload);

        console.log(
          `✉️ Sending 'ride:accepted' to driver room: ${data.driverId}`
        );
        io.to(data.driverId).emit("ride:accepted", acceptedPayload);

        // 4️⃣ Also emit directly to this socket as a fallback
        console.log(
          `✉️ Sending 'ride:accepted' directly to driver socket: ${socket.id}`
        );
        socket.emit("ride:accepted", acceptedPayload);

        await ridesCollection.doc(data.rideId).set(
          {
            lastAccepted: data,
            status: "accepted",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log(
          "📨 Notifications sent. Awaiting rider to join ride room..."
        );
      } catch (error) {
        console.error("❌ ERROR in ride:accept handler:", error);
      }
    }
  );

  // ===========================================================
  // 👥 Common ride room join (for both driver & rider)
  // ===========================================================
  socket.on("ride:join", (data: { rideId: string }) => {
    console.log(`🤝 Request to join ride room: ${data.rideId}`);
    socket.join(data.rideId);
    console.log(`✅ ${socket.id} joined ride room: ${data.rideId}`);
  });

  // ===========================================================
  // 📍 Driver location updates (realtime)
  // ===========================================================
  socket.on(
    "driver:location",
    async (data: {
      rideId: string;
      location: { lat: number; lng: number };
    }) => {
      console.log(
        `📍 Driver location update for ${data.rideId}: Lat ${data.location.lat}`
      ); // Too verbose for frequent updates
      await ridesCollection.doc(data.rideId).set(
        {
          lastDriverLocation: data.location,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      io.to(data.rideId).emit("ride:driverLocation", data.location);
      // console.log("📢 Location broadcasted.");
    }
  );

  // ===========================================================
  // 🚦 Ride status updates
  // ===========================================================
  socket.on(
    "ride:status",
    async (data: {
      rideId: string;
      status: "driverArrived" | "inProgress" | "completed" | "cancelled";
    }) => {
      console.log(
        `🔄 Ride status update received for ${data.rideId}: New status -> ${data.status}`
      );

      try {
        // Update in Firestore
        console.log(`💾 Updating Firestore status for ${data.rideId}...`);
        // await ridesCollection.doc(data.rideId).update({
        //   status: data.status,
        //   updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        // });
        const rideDoc = await ridesCollection.doc(data.rideId).get();
        if (rideDoc.exists) {
          await ridesCollection.doc(data.rideId).update({
            status: data.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } else {
          console.warn("Ride doc not found, creating new one...");
          await ridesCollection.doc(data.rideId).set({
            status: data.status,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        console.log("✔️ Firestore update successful.");

        // Broadcast to ride room
        console.log(
          `📢 Broadcasting status '${data.status}' to ride room ${data.rideId}`
        );

        await ridesCollection.doc(data.rideId).set(
          {
            status: data.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        io.to(data.rideId).emit("ride:status", data.status);
        console.log("✅ Status broadcast complete.");
      } catch (error) {
        console.error(
          `❌ ERROR updating ride status for ${data.rideId}:`,
          error
        );
      }
    }
  );

  // ===========================================================
  // 🚫 Cancel ride
  // ===========================================================
  socket.on("ride:cancel", async (data) => {
    try {
      await ridesCollection.doc(data.rideId).set(
        {
          status: "cencelled",
          lastCancelled: data,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      // ⚡ Emit cancellation immediately to ride room
      io.to(data.rideId).emit("ride:cancelled", data);
      console.log(`❌ Ride cancelled broadcasted in ride room: ${data.rideId}`);
    } catch (error) {
      console.error("❌ Error processing ride cancellation:", error);
    }
  });

  socket.on(
    "user:reconnect",
    async (data: {
      userId: string;
      type: "rider" | "driver";
      rideId?: string;
    }) => {
      console.log("User reconnecting:", data);

      socket.join(data.userId);
      if (data.type === "driver") socket.join("drivers");

      if (data.rideId) {
        try {
          const rideDoc = await ridesCollection.doc(data.rideId).get();
          if (rideDoc.exists) {
            const rideData = rideDoc.data();
            if (rideData?.lastCancelled) {
              socket.emit("ride:cancelled", rideData.lastCancelled);
              return;
            }

            // Emit the last events if available
            if (rideData?.status) {
              if (rideData.status == "accepted") {
                socket.emit("ride:accepted", rideData.lastAccepted);
              } else {
                socket.emit("ride:status", rideData.status);
              }
            }
            if (rideData?.lastDriverLocation) {
              socket.emit("ride:driverLocation", rideData.lastDriverLocation);
            }
          }
        } catch (error) {
          console.error("Error fetching last ride events on reconnect:", error);
        }
      }
    }
  );

  // ===========================================================
  // 🟢 Driver comes online
  // ===========================================================
  socket.on("driver:online", async (data: { driverId: string }) => {
    console.log(`🟢 Driver online: ${data.driverId}`);

    // 🛑 SOLUTION: Add validation guard clause
    if (!data.driverId) {
      console.error(
        "❌ ERROR: driverId is missing or invalid in driver:online event."
      );
      return; // Stop execution if ID is missing
    }

    socket.join("drivers");

    try {
      await db.collection("drivers").doc(data.driverId).set(
        // This is now safe
        {
          online: true,
          socketId: socket.id, // store socketId in Firestore
          lastOnline: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      io.emit("driver:statusUpdate", { driverId: data.driverId, online: true });
      console.log(`📢 Driver ${data.driverId} marked as online`);
    } catch (error) {
      console.error(`❌ Error setting driver online status:`, error);
    }
  });

  // ===========================================================
  // 🔴 Driver goes offline manually
  // ===========================================================
  socket.on("driver:offline", async (data: { driverId: string }) => {
    console.log(`🔴 Driver offline: ${data.driverId}`);

    // 🛑 SOLUTION: Add validation guard clause
    if (!data.driverId) {
      console.error(
        "❌ ERROR: driverId is missing or invalid in driver:offline event."
      );
      return; // Stop execution if ID is missing
    }

    socket.leave("drivers");

    try {
      await db.collection("drivers").doc(data.driverId).set(
        // This is now safe
        {
          online: false,
          socketId: null, // clear socketId
          lastOffline: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      io.emit("driver:statusUpdate", {
        driverId: data.driverId,
        online: false,
      });
      console.log(`📢 Driver ${data.driverId} marked as offline`);
    } catch (error) {
      console.error(`❌ Error setting driver offline status:`, error);
    }
  });

  // Automatically mark driver offline on disconnect
  socket.on("disconnect", async () => {
    console.log(`🚪❌ User disconnected: ${socket.id}`);

    try {
      // Find driver by socketId
      const snapshot = await db
        .collection("drivers")
        .where("socketId", "==", socket.id)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const driverId = doc.id;

        await db.collection("drivers").doc(driverId).set(
          {
            online: false,
            socketId: null,
            lastOffline: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        io.emit("driver:statusUpdate", { driverId, online: false });
        console.log(
          `📢 Driver ${driverId} automatically marked offline on disconnect`
        );
      }
    } catch (error) {
      console.error("❌ Error marking driver offline on disconnect:", error);
    }
  });
});

// ===========================================================
// 🚀 Start the server using your Wi-Fi IP address
// ===========================================================
const PORT = 3000;
const HOST = "0.0.0.0";
// const HOST = "192.168.100.81";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
