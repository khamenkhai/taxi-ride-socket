import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import dotenv from 'dotenv';
import { Redis } from "@upstash/redis"; 
import { upstashKey, upstashUrl } from "./secrets";
dotenv.config();

// ===========================================================
// ⚙️ CONFIGURATION & CONSTANTS
// ===========================================================
const PORT = 3000;
const HOST = process.env.HOST || "0.0.0.0";
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
interface UserJoinData {
  userId: string;
  type: UserType;
}
interface RideRequestData extends Record<string, any> {
  riderId: string;
  roomToken: string;
}
interface RideAcceptData {
  roomToken: string;
  rideId: string;
  driverLocation: Location;
  driverId: string;
  riderId: string;
}
interface RideJoinData {
  roomToken: string;
  rideId?: string;
}
interface DriverLocationData {
  rideId: string;
  roomToken: string;
  location: Location;
}
interface RideStatusPayload {
  rideId: string;
  driverId?: string;
  roomToken: string;
  status: RideStatus;
}
interface RideCancelData {
  rideId: string;
  roomToken: string;
  cancellationReason?: string;
  cancelledBy: "driver" | "rider";
}
interface UserReconnectData {
  userId: string;
  type: UserType;
  roomToken?: string;
}
interface DriverOnlineData {
  driverId: string;
}
interface DriverOfflineData {
  driverId: string;
}

// ===========================================================
// 🛠️ SERVER LOGIC SETUP
// ===========================================================
const pendingRideRequests: Map<string, NodeJS.Timeout> = new Map();

// 🚨 REDIS SETUP (Replace Firebase Admin Init)
console.log("🔥 Initializing Upstash Redis...");
// Replace with your actual Upstash Redis URL and Token
const redis = new Redis({
  url: upstashUrl,
  token: upstashKey,
});
console.log("✅ Upstash Redis initialized.");

// --- Redis Key Constants ---
const RIDES_KEY = (roomToken: string) => `ride:${roomToken}`;
const DRIVER_KEY = (driverId: string) => `driver:${driverId}`;
const ONLINE_DRIVERS_SET = "drivers:online";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log("🌐 Socket.IO Server and CORS configured.");

// ===========================================================
// 💡 UTILITY FUNCTIONS (DRY Principle)
// ===========================================================

/**
 * Gets the current server timestamp in milliseconds.
 * (Equivalent to Firebase's FieldValue.serverTimestamp())
 */
const serverTimestamp = () => Date.now();

/**
 * Updates the ride status and related data in Redis.
 */
const updateRideStatus = async (
  roomToken: string,
  status: RideStatus,
  additionalData: Record<string, any> = {}
) => {
  console.log(`💾 Updating Redis status for ${roomToken}: ${status}...`);
  const rideKey = RIDES_KEY(roomToken);
  const now = serverTimestamp();

  // Create the base update payload
  const updatePayload: Record<string, any> = {
    status: status,
    updatedAt: now,
    ...additionalData,
  };

  try {
    // Check if the ride document exists
    const exists = await redis.exists(rideKey);

    if (exists) {
      // Use hset for existing documents
      await redis.hset(rideKey, updatePayload);
    } else {
      // Use hset for new documents, ensuring creation time is set
      await redis.hset(rideKey, {
        ...updatePayload,
        createdAt: now,
      });
    }
    console.log("✔️ Redis update successful.");
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

  console.log(`📢 Broadcasting status '${status}' to room ${roomToken}.`);
  // Target the room directly using io.to(roomToken)
  socketIoInstance.to(roomToken).emit("ride:status", payload);
};

// ===========================================================
// 🔌 SOCKET EVENT HANDLERS
// ===========================================================

/**
 * DRY function to handle driver online/offline status updates in Redis.
 */
const updateDriverStatus = async (
  driverId: string,
  online: boolean,
  currentSocketId: string | null = null,
  socket: Socket
) => {
  if (!driverId) {
    console.error(
      "❌ ERROR: driverId is missing or invalid in driver status event."
    );
    return;
  }

  const driverKey = DRIVER_KEY(driverId);
  const now = serverTimestamp();

  const payload: Record<string, any> = {
    online: online ? "true" : "false", // Store booleans as strings in Redis Hash
    socketId: currentSocketId ?? "",
    updatedAt: now.toString(),
  };

  if (online) {
    payload.lastOnline = now.toString();
    socket.join(DRIVERS_ROOM);
    // Add driverId to the set of online drivers
    await redis.sadd(ONLINE_DRIVERS_SET, driverId);
  } else {
    payload.lastOffline = now.toString();
    socket.leave(DRIVERS_ROOM);
    // Remove driverId from the set of online drivers
    await redis.srem(ONLINE_DRIVERS_SET, driverId);
  }

  try {
    // Use hset for cleaner updates on driver doc
    await redis.hset(driverKey, payload);

    // Broadcast to everyone (or specific groups if needed)
    io.emit("driver:statusUpdate", { driverId, online });
    console.log(
      `📢 Driver ${driverId} marked as ${online ? "online" : "offline"}`
    );
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
      // Driver status will be set via 'driver:online' event,
      // but we join the room here for simplicity.
      socket.join(DRIVERS_ROOM);
      console.log(`🚕 Driver ${data.userId} joined ${DRIVERS_ROOM} room.`);
    }
    console.log(`✅ ${data.type} ${data.userId} joined successfully.`);
  });

  // ===========================================================
  // 2. RIDE REQUEST FLOW
  // ===========================================================
  socket.on("ride:request", async (rideRequestData: RideRequestData) => {
    console.log(
      `📲 New ride request received from rider: ${rideRequestData.riderId}`
    );

    const { roomToken, riderId } = rideRequestData;

    try {
      // 1️⃣ Rider joins the new room (roomToken is the unique request/ride ID)
      socket.join(roomToken);
      console.log(`🔗 Rider joined ride room: ${roomToken}`);

      // 2️⃣ Set initial status in Redis
      await updateRideStatus(roomToken, "requested", rideRequestData);

      // 3️⃣ Emit status to rider (and room) using consolidated event
      broadcastRideStatus(roomToken, "requested", roomToken, "", io); // Passing roomToken as rideId

      // 4️⃣ Get all online drivers (using the Redis SET) and send the request
      const onlineDriverIds = await redis.smembers(ONLINE_DRIVERS_SET);

      if (onlineDriverIds && onlineDriverIds.length > 0) {
        // Fetch socketId for all online drivers in one go (or iterate)
        const driverKeys = onlineDriverIds.map(DRIVER_KEY);
        const driverDataList = await Promise.all(
          driverKeys.map((key) => redis.hgetall(key))
        );

        for (let i = 0; i < driverDataList.length; i++) {
          const driverData = driverDataList[i];
          const driverId = onlineDriverIds[i];

          // Data in Redis Hash is stored as strings, so we access properties directly
          const driverSocketId = driverData?.socketId as string;

          if (driverSocketId) {
            // Send request payload directly to driver's socket
            io.to(driverSocketId).emit("ride:status", {
              rideId: roomToken, // Use roomToken as rideId
              roomToken: roomToken,
              status: "requested",
            } as RideStatusPayload);
            console.log(`📡 Ride request sent to driver ${driverId}`);
          }
        }

        // 5️⃣ Start timeout
        const timer = setTimeout(async () => {
          console.log(`⏰ Ride request ${roomToken} timed out!`);

          // Notify rider, update room, and Redis
          const timeoutPayload: RideStatusPayload = {
            rideId: roomToken,
            roomToken,
            status: "timedOut",
          };
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

    if (!roomToken)
      return console.error("❌ ERROR: roomToken missing in ride:accept.");

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

      // 4️⃣ Update Redis
      await updateRideStatus(roomToken, "accepted", {
        rideId,
        driverId,
        // Stringify the object for storage in Redis Hash
        driverLocation: JSON.stringify(driverLocation),
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
    if (!data.roomToken)
      return console.error("❌ ERROR: roomToken missing in ride:join.");

    console.log(`🤝 Request to join ride room: ${data.roomToken}`);
    socket.join(data.roomToken);
    console.log(`✅ ${socket.id} joined ride room: ${data.roomToken}`);
  });

  socket.on("driver:location", async (data: DriverLocationData) => {
    const { roomToken, location } = data;
    if (!roomToken)
      return console.error("❌ ERROR: roomToken missing in driver:location.");

    // Update Redis (less frequent)
    try {
      await redis.hset(RIDES_KEY(roomToken), {
        lastDriverLocation: JSON.stringify(location),
        updatedAt: serverTimestamp().toString(),
      });
    } catch (error) {
      console.error("❌ Error updating driver location in Redis:", error);
    }

    // Broadcast to ride room (high frequency)
    io.to(roomToken).emit("ride:driverLocation", location);
  });

  socket.on("ride:updateStatus", async (data: RideStatusPayload) => {
    const { roomToken, status, rideId, driverId } = data;

    if (!roomToken)
      return console.error("❌ ERROR: roomToken missing in ride:updateStatus.");

    console.log(`🔄 Status update for ${roomToken}: ${status}`);

    try {
      const additionalData: Record<string, any> = {};

      if (status === "accepted" && driverId)
        additionalData["driverId"] = driverId;
      if (status === "cancelled")
        additionalData["lastCancelled"] = Date.now().toString();

      await updateRideStatus(roomToken, status, additionalData);

      // Broadcast to ride room
      broadcastRideStatus(roomToken, status, rideId, driverId, io);
      console.log("✅ Status broadcast complete.");
    } catch (error) {
      console.error(
        `❌ ERROR processing ride:updateStatus for ${roomToken}:`,
        error
      );
    }
  });

  socket.on("ride:cancel", async (data: RideCancelData) => {
    const { roomToken, rideId } = data;

    if (!roomToken)
      return console.error("❌ ERROR: roomToken missing in ride:cancel.");

    // 1️⃣ Clear timeout if pending
    const timer = pendingRideRequests.get(roomToken);
    if (timer) {
      clearTimeout(timer);
      pendingRideRequests.delete(roomToken);
      console.log(`🧹 Cleared timeout for cancelled request ${roomToken}`);
    }

    try {
      // 2️⃣ Update Redis
      await updateRideStatus(roomToken, "cancelled", {
        // Stringify the object for storage in Redis Hash
        lastCancelled: JSON.stringify(data),
      });

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
        const rideData = await redis.hgetall(RIDES_KEY(data.roomToken));

        if (rideData) {
          // Convert stringified data back to objects/expected types
          const currentRideId = rideData.rideId || data.roomToken;
          const status = rideData.status as RideStatus;

          // 🛠️ FIX 1: Safely check type and parse 'lastDriverLocation'
          // const lastDriverLocation =
          //   rideData.lastDriverLocation &&
          //   typeof rideData.lastDriverLocation === "string"
          //     ? (JSON.parse(rideData.lastDriverLocation) as Location)
          //     : null;

          const lastDriverLocation = parseLocation(rideData.lastDriverLocation);

          console.log("*******************************");
          console.log(JSON.stringify(rideData));
          console.log("*******************************");

          // 🛠️ FIX 2: Safely check type for 'lastCancelled' before proceeding
          if (
            rideData.lastCancelled &&
            typeof rideData.lastCancelled === "string"
          ) {
            // Note: We don't need to parse lastCancelled just to emit the cancelled status
            // because the payload doesn't require the cancellation details object itself.
            socket.emit("ride:status", {
              rideId: currentRideId,
              roomToken: data.roomToken,
              status: "cancelled",
            } as RideStatusPayload);
            return;
          }

          if (status) {
            socket.emit("ride:status", {
              rideId: currentRideId,
              roomToken: data.roomToken,
              status: status,
            } as RideStatusPayload);
          }

          if (lastDriverLocation) {
            console.log("🤝 => Driver location is reemitted:");
            socket.emit("ride:driverLocation", lastDriverLocation);
          } else {
            console.log("🤝 => Last driver location not found");
          }
        }
      } catch (error) {
        // If the error is a JSON parse error, log the potentially corrupted data for debugging
        if (error instanceof SyntaxError) {
          console.error(
            "❌ JSON Parse Error on Reconnect. Corrupted ride data:"
            // rideData
          );
        }
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
      // 🚨 REDIS NOTE: Redis doesn't have a direct index on 'socketId',
      // so this logic is simplified/changed. The 'updateDriverStatus'
      // logic is already called when a driver explicitly goes offline.
      // For a disconnect, we must find the driver by socketId.

      // A full Redis solution might use an additional index (socketId:driverId)
      // but for simplicity, we rely on the `driver:offline` event or
      // a more complex scan/key iteration, which is generally discouraged in a busy server.

      // For now, we will assume a driver must send `driver:offline` or their status
      // will be managed by heartbeats/session management *outside* this disconnect handler.
      // However, to replicate the original logic of finding the driver by socketId, we'll
      // check the key that maps the socketId to driverId if we had one.

      // Since we don't have that index key, we will search for the driver by iterating over
      // the list of online drivers, which is the closest and most efficient alternative here.

      // 1. Get all online drivers
      const onlineDriverIds = await redis.smembers(ONLINE_DRIVERS_SET);

      if (onlineDriverIds && onlineDriverIds.length > 0) {
        const driverKeys = onlineDriverIds.map(DRIVER_KEY);
        const driverDataList = await Promise.all(
          driverKeys.map((key) => redis.hgetall(key))
        );

        // 2. Find the driver whose socketId matches the disconnected one
        const driverIndex = driverDataList.findIndex(
          (data) => data?.socketId === socket.id
        );

        if (driverIndex !== -1) {
          const driverId = onlineDriverIds[driverIndex];

          // Use the DRY function to update status
          await updateDriverStatus(driverId, false, null, socket);

          console.log(
            `📢 Driver ${driverId} automatically marked offline on disconnect`
          );
        }
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

const parseLocation = (value: any): Location | null => {
  if (!value) return null;

  // If already object
  if (typeof value === "object") {
    return value as Location;
  }

  // If string → parse it
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Location;
    } catch (e) {
      console.error("Invalid JSON for location:", value);
      return null;
    }
  }

  return null;
};
