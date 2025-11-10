import express from "express";
import http from "http";
import { Server } from "socket.io";
import admin from "firebase-admin";
import { serviceAccount } from "./secrets";

// Map<rideRequestId, NodeJS.Timeout>
const pendingRideRequests: Map<string, NodeJS.Timeout> = new Map();

console.log("🔥 Initializing Firebase Admin...");
// @ts-ignore
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

  // ===========================================================
  // 📲 New ride request (Client generates roomToken)
  // ===========================================================
  socket.on(
    "ride:request",
    async (
      rideRequestData: {
        rideRequestId: string;
        riderId: string;
        roomToken: string;
      } & Record<string, any>
    ) => {
      console.log(`📲 New ride request received from rider:`, rideRequestData);

      const rideRequestId = rideRequestData.rideRequestId;
      const roomToken = rideRequestData.roomToken; // The new real-time room ID and Firestore Doc ID

      // 1️⃣ Immediately join the rider to the new room
      console.log(`🔗 Rider joining ride room with roomToken: ${roomToken}`);

      socket.join(roomToken);

      // 2️⃣ Set initial status in Firestore
      try {
        // *** CHANGE: Use roomToken as the Firestore document ID ***
        await ridesCollection.doc(roomToken).set(
          {
            ...rideRequestData, // Save all initial data
            status: "requested",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            roomToken: roomToken, // Store roomToken in the Firestore ride document
          },
          { merge: true }
        );
        console.log(
          `💾 Initial ride status 'requested' saved to Firestore (Doc ID: ${roomToken}).`
        );

        // 3️⃣ ✨ NEW: Emit the status to the roomToken room
        io.to(roomToken).emit("ride:requested", rideRequestData);
        console.log(`📢 Broadcasted status 'requested' to room ${roomToken}.`);
      } catch (error) {
        console.error("❌ Error setting initial ride status:", error);
        // Important: You might want to disconnect the user or emit an error here
        return;
      }

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
              // Send the request including the roomToken
              io.to(driverSocketId).emit("ride:requested", rideRequestData);
              console.log(`📡 Ride request sent to driver ${doc.id}`);
            }
          });

          // Start timeout for this ride request
          // *** NOTE: Using rideRequestId for the timeout map key still makes sense here
          const timer = setTimeout(async () => {
            console.log(`⏰ Ride request ${rideRequestId} timed out!`);

            // Notify rider or handle fallback logic using riderId (their personal room)
            io.to(rideRequestData.riderId).emit("ride:timeout", {
              rideRequestId,
              roomToken,
              message: "No driver accepted in time",
            });
            // Also notify the ride room (roomToken)
            io.to(roomToken).emit("ride:timeout", {
              rideRequestId,
              roomToken,
              message: "No driver accepted in time",
            });

            // OPTIONAL: Update Firestore status to timedOut using roomToken as ID
            if (roomToken) {
              await ridesCollection
                .doc(roomToken)
                .update({ status: "timedOut" });
            }

            pendingRideRequests.delete(rideRequestId);
          }, 300000); // 300 seconds

          pendingRideRequests.set(rideRequestId, timer);
        } else {
          console.log("⚠️ No online drivers found for this ride request");
        }
      } catch (error) {
        console.error(
          "❌ Error sending ride request to online drivers:",
          error
        );
      }
    }
  );

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
      roomToken: string; 
    }) => {
      try {
        // 🛑 VALIDATION: Check for critical path ID
        if (!data.roomToken) {
          console.error("❌ ERROR: roomToken is missing in ride:accept event.");
          return;
        }

        console.log("💚 Ride ACCEPT event received");
        console.log("🔍 Full payload:", JSON.stringify(data, null, 2));

        // 1️⃣ Clear the timeout for this request
        const timer = pendingRideRequests.get(data.rideRequestId);
        if (timer) {
          clearTimeout(timer);
          pendingRideRequests.delete(data.rideRequestId);
          console.log(`🧹 Cleared timeout for request ${data.rideRequestId}`);
        }

        // 2️⃣ Driver joins the ride room (using roomToken)
        console.log(`🔗 Driver joining ride room: ${data.roomToken}`);
        socket.join(data.roomToken);
        console.log(
          `🚗 Driver socket ${socket.id} joined room: ${data.roomToken}`
        );

        // 3️⃣ Log current room memberships (optional, for debugging)
        const driverRoomSockets = await io.in(data.driverId).allSockets();
        const rideRoomSockets = await io.in(data.roomToken).allSockets();

        console.log(
          `🟢 Sockets in driverId room (${data.driverId}):`,
          driverRoomSockets
        );
        console.log(
          `🟢 Sockets in ride room (${data.roomToken}):`,
          rideRoomSockets
        );

        // 4️⃣ Notify rider and driver using the dedicated roomToken
        const acceptedPayload = {
          rideId: data.rideId, // Still useful data field
          driverLocation: data.driverLocation,
          roomToken: data.roomToken, // Include roomToken in the payload
        };

        // Emit to the common ride room (roomToken)
        console.log(
          `✉️ Sending 'ride:accepted' to ride room: ${data.roomToken}`
        );
        io.to(data.roomToken).emit("ride:accepted", acceptedPayload);

        // 5️⃣ Update Firestore using roomToken (the DB identifier)
        // *** CHANGE: Use roomToken as the Firestore document ID ***
        await ridesCollection.doc(data.roomToken).set(
          {
            // lastAccepted: acceptedPayload,
            status: "accepted",
            driverId: data.driverId, // Ensure driverId is saved upon acceptance
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log(
          "📨 Notifications sent. Ride status updated to 'accepted'."
        );
      } catch (error) {
        console.error("❌ ERROR in ride:accept handler:", error);
      }
    }
  );

  // ===========================================================
  // 👥 Common ride room join (for both driver & rider)
  // Re-joining the roomToken for stability
  // ===========================================================
  socket.on("ride:join", (data: { roomToken: string; rideId?: string }) => {
    // 🛑 VALIDATION: Check for critical path ID
    if (!data.roomToken) {
      console.error("❌ ERROR: roomToken is missing in ride join event.");
      return;
    }

    // Client can use this to explicitly join the roomToken room after acceptance
    console.log(`🤝 Request to join ride room: ${data.roomToken}`);
    socket.join(data.roomToken);
    console.log(`✅ ${socket.id} joined ride room: ${data.roomToken}`);
  });

  // ===========================================================
  // 📍 Driver location updates (realtime)
  // Uses roomToken for broadcast
  // ===========================================================
  socket.on(
    "driver:location",
    async (data: {
      rideId: string; // Used for data field (optional)
      roomToken: string; // Used for broadcast AND Firestore update
      location: { lat: number; lng: number };
    }) => {
      // 🛑 VALIDATION: Check for critical path ID
      if (!data.roomToken) {
        console.error(
          "❌ ERROR: roomToken is missing in driver:location event."
        );
        return;
      }

      // console.log(`📍 Driver location update for ${data.roomToken}`); // Too verbose for frequent updates

      // Update Firestore using roomToken (the DB identifier)
      // *** CHANGE: Use roomToken as the Firestore document ID ***
      await ridesCollection.doc(data.roomToken).set(
        {
          lastDriverLocation: data.location,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      // Broadcast to ride room using roomToken
      io.to(data.roomToken).emit("ride:driverLocation", data.location);
      // console.log("📢 Location broadcasted.");
    }
  );

  // ===========================================================
  // 🚦 Ride status updates
  // Uses roomToken for broadcast
  // ===========================================================
  socket.on(
    "ride:status",
    async (data: {
      rideId: string; // Used for data field (optional)
      roomToken: string; // Used for broadcast AND Firestore update
      status: "driverArrived" | "inProgress" | "completed" | "cancelled";
    }) => {
      // 🛑 VALIDATION: Check for critical path ID
      if (!data.roomToken) {
        console.error("❌ ERROR: roomToken is missing in ride:status event.");
        return;
      }

      console.log(
        `🔄 Ride status update received for roomToken ${data.roomToken}: New status -> ${data.status}`
      );

      try {
        // Update in Firestore using roomToken
        console.log(`💾 Updating Firestore status for ${data.roomToken}...`);

        const updatePayload = {
          status: data.status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        // *** CHANGE: Use roomToken as the Firestore document ID ***
        const rideDoc = await ridesCollection.doc(data.roomToken).get();
        if (rideDoc.exists) {
          await ridesCollection.doc(data.roomToken).update(updatePayload);
        } else {
          // This is unlikely if the ride was properly requested/accepted, but safe to include
          await ridesCollection.doc(data.roomToken).set(
            {
              ...updatePayload,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        console.log("✔️ Firestore update successful.");

        // Broadcast to ride room using roomToken
        console.log(
          `📢 Broadcasting status '${data.status}' to ride room ${data.roomToken}`
        );

        io.to(data.roomToken).emit("ride:status", data.status);
        console.log("✅ Status broadcast complete.");
      } catch (error) {
        console.error(
          `❌ ERROR updating ride status for ${data.roomToken}:`,
          error
        );
      }
    }
  );

  // ===========================================================
  // 🚫 Cancel ride
  // Uses roomToken for broadcast
  // ===========================================================
  socket.on(
    "ride:cancel",
    async (data: {
      rideId: string; // Used for data field (optional)
      roomToken: string; // Used for broadcast AND Firestore update
      cancellationReason?: string;
      cancelledBy: 'driver' | 'rider';
    }) => {
      // 🛑 VALIDATION: Check for critical path ID
      if (!data.roomToken) {
        console.error("❌ ERROR: roomToken is missing in ride:cancel event.");
        return;
      }

      try {
        // Update Firestore using roomToken
        // *** CHANGE: Use roomToken as the Firestore document ID ***
        await ridesCollection.doc(data.roomToken).set(
          {
            status: "cancelled", // Correct spelling
            lastCancelled: data,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        // ⚡ Emit cancellation immediately to ride room using roomToken
        io.to(data.roomToken).emit("ride:cancelled", data);
        console.log(
          `❌ Ride cancelled broadcasted in ride room: ${data.roomToken}`
        );
      } catch (error) {
        console.error("❌ Error processing ride cancellation:", error);
      }
    }
  );

  // ===========================================================
  // 🔄 Reconnect Logic
  // Uses roomToken for rejoining the active communication room
  // ===========================================================
  socket.on(
    "user:reconnect",
    async (data: {
      userId: string;
      type: "rider" | "driver";
      roomToken?: string; // ✨ NEW: Use this to rejoin the room AND fetch data
    }) => {
      console.log("User reconnecting:", data);

      socket.join(data.userId);

      if (data.type === "driver") socket.join("drivers");

      // Join the active ride room if a roomToken is provided
      if (data.roomToken) {
        socket.join(data.roomToken);
        console.log(`🚪 Rejoined room: ${data.roomToken}`);
      }

      // *** CHANGE: Use roomToken as the Firestore document ID for fetching ***
      if (data.roomToken) {
        try {
          const rideDoc = await ridesCollection.doc(data.roomToken).get();
          if (rideDoc.exists) {
            const rideData = rideDoc.data();
            if (rideData?.lastCancelled) {
              socket.emit("ride:cancelled", rideData.lastCancelled);
              // Important: return after cancellation to avoid sending other status updates
              return;
            }

            // Emit the last events if available
            if (rideData?.status) {
              if (rideData.status == "requested") {
                // The accepted payload now contains the roomToken
                
                socket.emit("ride:requested", {
                  rideRequestId: rideData.rideRequestId,
                  riderId: rideData.riderId,
                  roomToken: rideData.roomToken,
                });

                console.log("this is requested heheeh2ehe");
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

  // ... (driver:online, driver:offline, disconnect handlers remain the same)
  // The logic for driver online/offline status in Firestore does not change.

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
// const HOST = "0.0.0.0";
const HOST = "192.168.100.81";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
