import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import dotenv from "dotenv";
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
// (Interfaces updated to use a single rideId)
interface UserJoinData {
  userId: string;
  type: UserType;
}
interface RideRequestData extends Record<string, any> {
  riderId: string;
  rideId: string; // previously roomToken
}
interface RideAcceptData {
  rideId: string;
  driverLocation: Location;
  driverId: string;
  riderId: string;
}
interface RideJoinData {
  rideId: string;
  rideIdOptional?: string;
}
interface DriverLocationData {
  rideId: string;
  location: Location;
}
interface RideStatusPayload {
  rideId: string;
  driverId?: string;
  status: RideStatus;
}
interface RideCancelData {
  rideId: string;
  cancellationReason?: string;
  cancelledBy: "driver" | "rider";
}
interface UserReconnectData {
  userId: string;
  type: UserType;
  rideId?: string;
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
const RIDES_KEY = (rideId: string) => `ride:${rideId}`;
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
  rideId: string,
  status: RideStatus,
  additionalData: Record<string, any> = {}
) => {
  console.log(`💾 Updating Redis status for ${rideId}: ${status}...`);
  const rideKey = RIDES_KEY(rideId);
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
    console.error(`❌ ERROR updating ride status for ${rideId}:`, error);
    throw error;
  }
};

/**
 * Broadcasts the consolidated ride status event.
 */
const broadcastRideStatus = (
  rideId: string,
  status: RideStatus,
  driverId: string = "",
  socketIoInstance: Server | Socket = io
) => {
  const payload: RideStatusPayload = {
    rideId,
    status,
  };

  if (driverId) {
    payload.driverId = driverId;
  }

  console.log(`📢 Broadcasting status '${status}' to ride ${rideId}.`);
  // Target the room directly using io.to(rideId)
  socketIoInstance.to(rideId).emit("ride:status", payload);
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

    const { rideId, riderId } = rideRequestData;

    try {
      // 1️⃣ Rider joins the new room (rideId is the unique request/ride ID)
      socket.join(rideId);
      console.log(`🔗 Rider joined ride room: ${rideId}`);

      // 2️⃣ Set initial status in Redis
      await updateRideStatus(rideId, "requested", rideRequestData);

      // 3️⃣ Emit status to rider (and room) using consolidated event
      broadcastRideStatus(rideId, "requested", "", io);

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
              rideId: rideId,
              status: "requested",
            } as RideStatusPayload);
            console.log(`📡 Ride request sent to driver ${driverId}`);
          }
        }

        // 5️⃣ Start timeout
        const timer = setTimeout(async () => {
          console.log(`⏰ Ride request ${rideId} timed out!`);

          // Notify rider, update room, and Redis
          const timeoutPayload: RideStatusPayload = {
            rideId,
            status: "timedOut",
          };
          io.to(riderId).emit("ride:status", timeoutPayload); 
          broadcastRideStatus(rideId, "timedOut", "", io); // Notify room
          await updateRideStatus(rideId, "timedOut");

          pendingRideRequests.delete(rideId);
        }, RIDE_REQUEST_TIMEOUT_MS);

        pendingRideRequests.set(rideId, timer);
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
    // prefer rideId field
    const rideId = data.rideId ;

    if (!rideId) return console.error("❌ ERROR: rideId missing in ride:accept.");

    const { driverId, driverLocation } = data;

    console.log(`💚 Ride ACCEPT received: ${rideId}`);

    try {
      // 1️⃣ Clear timeout
      const timer = pendingRideRequests.get(rideId);
      if (timer) {
        clearTimeout(timer);
        pendingRideRequests.delete(rideId);
        console.log(`🧹 Cleared timeout for request ${rideId}`);
      }

      // 2️⃣ Driver joins the ride room
      socket.join(rideId);
      console.log(`🚗 Driver ${driverId} joined room: ${rideId}`);

      // 3️⃣ Notify using consolidated ride status event
      broadcastRideStatus(rideId, "accepted", driverId, io);

      // 4️⃣ Update Redis
      await updateRideStatus(rideId, "accepted", {
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
    const rideId = data.rideId || (data.rideIdOptional as string);
    if (!rideId) return console.error("❌ ERROR: rideId missing in ride:join.");

    console.log(`🤝 Request to join ride room: ${rideId}`);
    socket.join(rideId);
    console.log(`✅ ${socket.id} joined ride room: ${rideId}`);
  });

  socket.on("driver:location", async (data: DriverLocationData) => {
    const { rideId, location } = data;
    if (!rideId)
      return console.error("❌ ERROR: rideId missing in driver:location.");

    // Update Redis (less frequent)
    try {
      await redis.hset(RIDES_KEY(rideId), {
        lastDriverLocation: JSON.stringify(location),
        updatedAt: serverTimestamp().toString(),
      });
    } catch (error) {
      console.error("❌ Error updating driver location in Redis:", error);
    }

    // Broadcast to ride room (high frequency)
    io.to(rideId).emit("ride:driverLocation", location);
  });

  socket.on("ride:updateStatus", async (data: RideStatusPayload) => {
    const { rideId, status, driverId } = data;

    if (!rideId)
      return console.error("❌ ERROR: rideId missing in ride:updateStatus.");

    console.log(`🔄 Status update for ${rideId}: ${status}`);

    try {
      const additionalData: Record<string, any> = {};

      if (status === "accepted" && driverId) additionalData["driverId"] = driverId;
      if (status === "cancelled") additionalData["lastCancelled"] = Date.now().toString();

      await updateRideStatus(rideId, status, additionalData);

      // Broadcast to ride room
      broadcastRideStatus(rideId, status, driverId ?? "", io);
      console.log("✅ Status broadcast complete.");
    } catch (error) {
      console.error(
        `❌ ERROR processing ride:updateStatus for ${rideId}:`,
        error
      );
    }
  });

  socket.on("ride:cancel", async (data: RideCancelData) => {
    const { rideId } = data;

    if (!rideId) return console.error("❌ ERROR: rideId missing in ride:cancel.");

    // 1️⃣ Clear timeout if pending
    const timer = pendingRideRequests.get(rideId);
    if (timer) {
      clearTimeout(timer);
      pendingRideRequests.delete(rideId);
      console.log(`🧹 Cleared timeout for cancelled request ${rideId}`);
    }

    try {
      // 2️⃣ Update Redis
      await updateRideStatus(rideId, "cancelled", {
        // Stringify the object for storage in Redis Hash
        lastCancelled: JSON.stringify(data),
      });

      // 3️⃣ Emit using consolidated ride status event
      broadcastRideStatus(rideId, "cancelled", "", io);
      console.log(`❌ Ride cancelled broadcasted in ride room: ${rideId}`);
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

    if (data.rideId) {
      socket.join(data.rideId);
      console.log(`🚪 Rejoined ride room: ${data.rideId}`);

      try {
        const rideData = await redis.hgetall(RIDES_KEY(data.rideId));

        if (rideData) {
          // Convert stringified data back to objects/expected types
          const currentRideId = rideData.rideId || data.rideId;
          const status = rideData.status as RideStatus;

          const lastDriverLocation = parseLocation(rideData.lastDriverLocation);

          console.log("*******************************");
          console.log(JSON.stringify(rideData));
          console.log("*******************************");

          // Safely check type for 'lastCancelled' before proceeding
          if (
            rideData.lastCancelled &&
            typeof rideData.lastCancelled === "string"
          ) {
            // We don't need to parse lastCancelled just to emit the cancelled status
            socket.emit("ride:status", {
              rideId: currentRideId,
              status: "cancelled",
            } as RideStatusPayload);
            return;
          }

          if (status) {
            socket.emit("ride:status", {
              rideId: currentRideId,
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