import express from "express";
import http from "http";
import { Server } from "socket.io";
import admin from "firebase-admin";

// ⚠️ IMPORTANT: Replace this with your actual service account path or object
// Initialize Firebase Admin
const serviceAccount = {};

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
const rideRequestsCollection = db.collection("rideRequests");
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

    // Emit the full ride request payload to all drivers
    console.log("📡 Sending 'ride:requested' to all drivers...");
    socket.to("drivers").emit("ride:requested", rideRequestData);
    console.log("🚀 Ride request sent to drivers successfully.");
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
      // console.log(`📍 Driver location update for ${data.rideId}: Lat ${data.location.lat}`); // Too verbose for frequent updates
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
  socket.on(
    "ride:cancel",
    async (data: {
      rideId: string;
      cancelledBy: "rider" | "driver";
      reason?: string;
    }) => {
      console.log(
        `🔥🚫 Ride cancellation received for ${data.rideId} by ${data.cancelledBy}`
      );

      try {
        console.log(
          `💾 Checking Firestore for ride cancellation: ${data.rideId}...`
        );
        const rideDoc = await ridesCollection.doc(data.rideId).get();
        if (!rideDoc.exists) {
          console.warn(
            `⚠️ Ride doc ${data.rideId} does not exist. It will be created.`
          );
        } else {
          console.log(
            `✅ Ride doc ${data.rideId} exists. Proceeding to update.`
          );
        }

        await ridesCollection.doc(data.rideId).set(
          {
            lastCancelled: data,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log("✔️ Firestore cancellation successful.");
      } catch (error) {
        console.error(
          `❌ ERROR processing ride cancellation for ${data.rideId}:`,
          error
        );
      }
    }
  );

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
            // if (rideData?.lastAccepted) {
            //   socket.emit("ride:accepted", rideData.lastAccepted);
            // }
            if (rideData?.lastCancelled) {
              socket.emit("ride:cancelled", rideData.lastCancelled);
            }
          }
        } catch (error) {
          console.error("Error fetching last ride events on reconnect:", error);
        }
      }
    }
  );

  // ===========================================================
  // ❌ Disconnect cleanup
  // ===========================================================
  socket.on("disconnect", () => {
    console.log(`🚪❌ User disconnected: ${socket.id}`);
  });
});

// ===========================================================
// 🚀 Start the server using your Wi-Fi IP address
// ===========================================================
const PORT = 3000;
const HOST = "192.168.100.76";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
