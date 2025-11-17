import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import admin from "firebase-admin";
import { serviceAccount } from "./secrets";

// ===========================================================
// ⚙️ CONFIGURATION & CONSTANTS
// ===========================================================
const PORT = 3000;
const HOST = "192.168.100.81"; 
const RIDE_REQUEST_TIMEOUT_MS = 300000;
const DRIVERS_ROOM = "drivers";

// --- Base Types ---
type UserType = "rider" | "driver";
type RideStatus =
  | "requested"
  | "accepted"
  | "driverArrived"
  | "inProgress"
  | "completed"
  | "cancelled"
  | "timedOut";

interface Location {
  lat: number;
  lng: number;
}

// --- Event Payloads ---
// (Interfaces remain the same for strict typing)
interface UserJoinData { userId: string; type: UserType; }
interface RideRequestData extends Record<string, any> { riderId: string; roomToken: string; }
interface RideAcceptData { roomToken: string; rideId: string; driverLocation: Location; driverId: string; riderId: string; }
interface RideJoinData { roomToken: string; rideId?: string; }
interface DriverLocationData { rideId: string; roomToken: string; location: Location; }
interface RideStatusPayload { rideId: string; driverId?: string; roomToken: string; status: RideStatus; }
interface RideCancelData { rideId: string; roomToken: string; cancellationReason?: string; cancelledBy: "driver" | "rider"; }
interface UserReconnectData { userId: string; type: UserType; roomToken?: string; }
interface DriverOnlineData { driverId: string; }
interface DriverOfflineData { driverId: string; }


// ===========================================================
// 🛠️ SERVER LOGIC SETUP
// ===========================================================
const pendingRideRequests: Map<string, NodeJS.Timeout> = new Map();

console.log("🔥 Initializing Firebase Admin...");
// @ts-ignore
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
console.log("✅ Firebase Admin initialized.");

const db = admin.firestore();
const ridesCollection = db.collection("rides");
const driversCollection = db.collection("drivers");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log("🌐 Socket.IO Server and CORS configured.");
console.log("📚 Firestore collections referenced.");


// ===========================================================
// 💡 UTILITY FUNCTIONS (DRY Principle)
// ===========================================================

/**
 * Updates the ride status and related data in Firestore.
 */
const updateRideStatus = async (
  roomToken: string,
  status: RideStatus,
  additionalData: Record<string, any> = {}
) => {
  console.log(`💾 Updating Firestore status for ${roomToken}: ${status}...`);
  const updatePayload: Record<string, any> = {
    status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...additionalData,
  };

  try {
    const rideDoc = await ridesCollection.doc(roomToken).get();
    
    if (rideDoc.exists) {
      // Use update for existing documents
      await ridesCollection.doc(roomToken).update(updatePayload);
    } else {
      // Use set with merge:true for new documents, ensuring creation time is set
      await ridesCollection.doc(roomToken).set(
        {
          ...updatePayload,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    console.log("✔️ Firestore update successful.");
  } catch (error) {
    console.error(`❌ ERROR updating ride status for ${roomToken}:`, error);
    throw error;
  }
};

/**
 * Broadcasts the consolidated ride status event.
 */
const broadcastRideStatus = (
  roomToken: string,
  status: RideStatus,
  rideId: string = "",
  driverId: string = "",
  socketIoInstance: Server | Socket
) => {
  const payload: RideStatusPayload = {
    rideId,
    roomToken,
    status,
  };

  if (driverId) {
    payload.driverId = driverId;
  }

  console.log(
    `📢 Broadcasting status '${status}' to room ${roomToken}.`
  );
  // Target the room directly using io.to(roomToken)
  socketIoInstance.to(roomToken).emit("ride:status", payload);
};


// ===========================================================
// 🔌 SOCKET EVENT HANDLERS
// ===========================================================

/**
 * DRY function to handle driver online/offline status updates in Firestore.
 */
const updateDriverStatus = async (
  driverId: string,
  online: boolean,
  currentSocketId: string | null = null,
  socket: Socket
) => {
  if (!driverId) {
    console.error("❌ ERROR: driverId is missing or invalid in driver status event.");
    return;
  }

  const payload: Record<string, any> = {
    online,
    socketId: currentSocketId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  if (online) {
    payload.lastOnline = admin.firestore.FieldValue.serverTimestamp();
    socket.join(DRIVERS_ROOM);
  } else {
    payload.lastOffline = admin.firestore.FieldValue.serverTimestamp();
    socket.leave(DRIVERS_ROOM);
  }

  try {
    // Use set with merge:true for cleaner updates on driver doc
    await driversCollection.doc(driverId).set(payload, { merge: true });

    // Broadcast to everyone (or specific groups if needed)
    io.emit("driver:statusUpdate", { driverId, online });
    console.log(`📢 Driver ${driverId} marked as ${online ? "online" : "offline"}`);
  } catch (error) {
    console.error(`❌ Error setting driver status for ${driverId}:`, error);
  }
};

// --- Connection Handler ---
io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // ===========================================================
  // 1. USER AUTH & ROOM JOIN
  // ===========================================================
  socket.on("user:join", (data: UserJoinData) => {
    console.log(`👤 ${data.type} attempting to join room: ${data.userId}`);
    socket.join(data.userId);

    if (data.type === "driver") {
      socket.join(DRIVERS_ROOM);
      console.log(`🚕 Driver ${data.userId} joined ${DRIVERS_ROOM} room.`);
    }
    console.log(`✅ ${data.type} ${data.userId} joined successfully.`);
  });

  // ===========================================================
  // 2. RIDE REQUEST FLOW
  // ===========================================================
  socket.on("ride:request", async (rideRequestData: RideRequestData) => {
    console.log(`📲 New ride request received from rider: ${rideRequestData.riderId}`);

    const { roomToken, riderId } = rideRequestData;

    try {
      // 1️⃣ Rider joins the new room (roomToken is the unique request/ride ID)
      socket.join(roomToken);
      console.log(`🔗 Rider joined ride room: ${roomToken}`);

      // 2️⃣ Set initial status in Firestore
      await updateRideStatus(roomToken, "requested", rideRequestData);

      // 3️⃣ Emit status to rider (and room) using consolidated event
      broadcastRideStatus(roomToken, "requested", roomToken, "", io); // Passing roomToken as rideId

      // 4️⃣ Get all online drivers and send the request
      const snapshot = await driversCollection.where("online", "==", true).get();

      if (!snapshot.empty) {
        snapshot.docs.forEach((doc) => {
          const driverSocketId = doc.data().socketId;
          if (driverSocketId) {
            // Send request payload directly to driver's socket
            io.to(driverSocketId).emit("ride:status", {
              rideId: roomToken, // Use roomToken as rideId
              roomToken: roomToken,
              status: "requested",
            } as RideStatusPayload);
            console.log(`📡 Ride request sent to driver ${doc.id}`);
          }
        });

        // 5️⃣ Start timeout
        const timer = setTimeout(async () => {
          console.log(`⏰ Ride request ${roomToken} timed out!`);

          // Notify rider, update room, and Firestore
          const timeoutPayload: RideStatusPayload = { rideId: roomToken, roomToken, status: "timedOut" };
          io.to(riderId).emit("ride:status", timeoutPayload); // Notify rider specifically
          broadcastRideStatus(roomToken, "timedOut", roomToken, "", io); // Notify room
          await updateRideStatus(roomToken, "timedOut");

          pendingRideRequests.delete(roomToken);
        }, RIDE_REQUEST_TIMEOUT_MS);

        pendingRideRequests.set(roomToken, timer);
      } else {
        console.log("⚠️ No online drivers found for this ride request");
      }
    } catch (error) {
      console.error("❌ Error processing ride:request:", error);
    }
  });

  // ===========================================================
  // 3. RIDE ACCEPT FLOW
  // ===========================================================
  socket.on("ride:accept", async (data: RideAcceptData) => {
    const { roomToken, rideId, driverId, driverLocation } = data;

    if (!roomToken) return console.error("❌ ERROR: roomToken missing in ride:accept.");

    console.log(`💚 Ride ACCEPT received: ${roomToken}`);

    try {
      // 1️⃣ Clear timeout
      const timer = pendingRideRequests.get(roomToken);
      if (timer) {
        clearTimeout(timer);
        pendingRideRequests.delete(roomToken);
        console.log(`🧹 Cleared timeout for request ${roomToken}`);
      }

      // 2️⃣ Driver joins the ride room
      socket.join(roomToken);
      console.log(`🚗 Driver ${driverId} joined room: ${roomToken}`);

      // 3️⃣ Notify using consolidated ride status event
      broadcastRideStatus(roomToken, "accepted", rideId, driverId, io);

      // 4️⃣ Update Firestore
      await updateRideStatus(roomToken, "accepted", {
        rideId, // Storing the rideId if it differs from roomToken, otherwise redundancy is fine.
        driverId,
        driverLocation,
      });

      console.log("✅ Ride status updated to 'accepted'.");
    } catch (error) {
      console.error("❌ ERROR in ride:accept handler:", error);
    }
  });

  // ===========================================================
  // 4. COMMON RIDE ACTIONS
  // ===========================================================

  socket.on("ride:join", (data: RideJoinData) => {
    if (!data.roomToken) return console.error("❌ ERROR: roomToken missing in ride:join.");
    
    console.log(`🤝 Request to join ride room: ${data.roomToken}`);
    socket.join(data.roomToken);
    console.log(`✅ ${socket.id} joined ride room: ${data.roomToken}`);
  });

  socket.on("driver:location", async (data: DriverLocationData) => {
    const { roomToken, location } = data;
    if (!roomToken) return console.error("❌ ERROR: roomToken missing in driver:location.");

    // Update Firestore (less frequent)
    try {
      await ridesCollection.doc(roomToken).set(
        { lastDriverLocation: location, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (error) {
      console.error("❌ Error updating driver location in Firestore:", error);
    }

    // Broadcast to ride room (high frequency)
    io.to(roomToken).emit("ride:driverLocation", location);
  });

  socket.on("ride:updateStatus", async (data: RideStatusPayload) => {
    const { roomToken, status, rideId, driverId } = data;

    if (!roomToken) return console.error("❌ ERROR: roomToken missing in ride:updateStatus.");

    console.log(`🔄 Status update for ${roomToken}: ${status}`);

    try {
      const additionalData: Record<string, any> = {};

      if (status === "accepted" && driverId) additionalData["driverId"] = driverId;
      if (status === "cancelled") additionalData["lastCancelled"] = Date.now().toString();

      await updateRideStatus(roomToken, status, additionalData);

      // Broadcast to ride room
      broadcastRideStatus(roomToken, status, rideId, driverId, io);
      console.log("✅ Status broadcast complete.");
    } catch (error) {
      console.error(`❌ ERROR processing ride:updateStatus for ${roomToken}:`, error);
    }
  });

  socket.on("ride:cancel", async (data: RideCancelData) => {
    const { roomToken, rideId } = data;

    if (!roomToken) return console.error("❌ ERROR: roomToken missing in ride:cancel.");

    // 1️⃣ Clear timeout if pending
    const timer = pendingRideRequests.get(roomToken);
    if (timer) {
      clearTimeout(timer);
      pendingRideRequests.delete(roomToken);
      console.log(`🧹 Cleared timeout for cancelled request ${roomToken}`);
    }

    try {
      // 2️⃣ Update Firestore
      await updateRideStatus(roomToken, "cancelled", { lastCancelled: data });

      // 3️⃣ Emit using consolidated ride status event
      broadcastRideStatus(roomToken, "cancelled", rideId, "", io);
      console.log(`❌ Ride cancelled broadcasted in ride room: ${roomToken}`);
    } catch (error) {
      console.error("❌ Error processing ride cancellation:", error);
    }
  });

  // ===========================================================
  // 5. RECONNECT LOGIC
  // ===========================================================
  socket.on("user:reconnect", async (data: UserReconnectData) => {
    console.log("User reconnecting:", data);

    socket.join(data.userId);
    if (data.type === "driver") socket.join(DRIVERS_ROOM);

    if (data.roomToken) {
      socket.join(data.roomToken);
      console.log(`🚪 Rejoined room: ${data.roomToken}`);

      try {
        const rideDoc = await ridesCollection.doc(data.roomToken).get();
        if (rideDoc.exists) {
          const rideData = rideDoc.data();
          const currentRideId = rideData?.rideId || data.roomToken; // Fallback to roomToken

          if (rideData?.lastCancelled) {
            socket.emit("ride:status", {
              rideId: currentRideId,
              roomToken: data.roomToken,
              status: "cancelled",
            } as RideStatusPayload);
            return;
          }

          if (rideData?.status) {
            socket.emit("ride:status", {
              rideId: currentRideId,
              roomToken: data.roomToken,
              status: rideData.status as RideStatus,
            } as RideStatusPayload);
          }

          if (rideData?.lastDriverLocation) {
            socket.emit("ride:driverLocation", rideData.lastDriverLocation);
          }
        }
      } catch (error) {
        console.error("Error fetching last ride events on reconnect:", error);
      }
    }
  });
  
  // ===========================================================
  // 6. DRIVER ONLINE/OFFLINE
  // ===========================================================
  socket.on("driver:online", (data: DriverOnlineData) => {
    console.log(`🟢 Driver online: ${data.driverId}`);
    updateDriverStatus(data.driverId, true, socket.id, socket);
  });

  socket.on("driver:offline", (data: DriverOfflineData) => {
    console.log(`🔴 Driver offline: ${data.driverId}`);
    updateDriverStatus(data.driverId, false, null, socket);
  });

  // ===========================================================
  // 7. DISCONNECT HANDLING
  // ===========================================================
  socket.on("disconnect", async () => {
    console.log(`🚪❌ User disconnected: ${socket.id}`);

    try {
      const snapshot = await driversCollection
        .where("socketId", "==", socket.id)
        .limit(1)
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        const driverId = doc.id;

        // Use the DRY function to update status
        // Pass a dummy socket instance if the original is gone, but here we use the disconnect socket
        // Note: For 'disconnect', the socket is still available for status updates
        await updateDriverStatus(driverId, false, null, socket); 

        console.log(`📢 Driver ${driverId} automatically marked offline on disconnect`);
      }
    } catch (error) {
      console.error("❌ Error marking driver offline on disconnect:", error);
    }
  });
});

// ===========================================================
// 🚀 Start the server
// ===========================================================
server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});