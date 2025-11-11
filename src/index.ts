import express from "express";
import http from "http";
import { Server, Socket } from "socket.io";
import { Redis } from "@upstash/redis";
import { upstashKey, upstashUrl } from "./secrets";

// --- Type Definitions for Payloads ---
interface UserJoinData {
  userId: string;
  type: "rider" | "driver";
}

interface RideRequestData extends Record<string, any> {
  rideRequestId: string;
  riderId: string;
  roomToken: string;
}

interface RideAcceptData {
  rideRequestId: string;
  rideId: string;
  driverLocation: { lat: number; lng: number };
  driverId: string;
  riderId: string;
  roomToken: string;
}

interface RideRoomData {
  roomToken: string;
  rideId?: string;
}

interface DriverLocationData extends RideRoomData {
  rideId: string;
  location: { lat: number; lng: number };
}

type RideStatus = "driverArrived" | "inProgress" | "completed" | "cancelled";

interface RideStatusData extends RideRoomData {
  rideId: string;
  status: RideStatus;
}

interface RideCancelData extends RideRoomData {
  rideId: string;
  cancellationReason?: string;
  cancelledBy: "driver" | "rider";
}

interface DriverToggleOnlineData {
  driverId: string;
}

interface UserReconnectData {
  userId: string;
  type: "rider" | "driver";
  roomToken?: string;
}

// --- Constants & Configuration ---
const REDIS_URL = upstashUrl;
const REDIS_TOKEN = upstashKey;
const RIDE_TIMEOUT_MS = 300000; // 5 minutes

console.log("🔥 Initializing Redis Client...");
const redis = new Redis({
  url: REDIS_URL,
  token: REDIS_TOKEN,
});
console.log("✅ Redis Client initialized.");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log("🌐 Socket.IO Server and CORS configured.");

// Map<rideRequestId, NodeJS.Timeout> - Stores active timeouts for pending requests
const pendingRideRequests: Map<string, NodeJS.Timeout> = new Map();

const updateRideInRedis = async (
  roomToken: string,
  payload: Record<string, any>
) => {
  const updatePayload = {
    ...payload,
    updatedAt: Date.now(),
  };
  await redis.hset(`ride:${roomToken}`, updatePayload);
  console.log(
    `💾 Redis Hash 'ride:${roomToken}' updated. Status: ${
      payload.status || "N/A"
    }`
  );
};

/**
 * Updates a driver's online status and related metadata in Redis.
 */
const updateDriverStatusInRedis = async (
  driverId: string,
  isOnline: boolean,
  socketId: string
) => {
  const statusKey = isOnline ? "lastOnline" : "lastOffline";
  const statusValue = isOnline ? "true" : "false";
  const newSocketId = isOnline ? socketId : "";

  await redis.hset(`driver:${driverId}`, {
    online: statusValue,
    socketId: newSocketId,
    [statusKey]: Date.now(),
  });

  io.emit("driver:statusUpdate", { driverId, online: isOnline });
  console.log(
    `📢 Driver ${driverId} marked as ${isOnline ? "online" : "offline"}.`
  );
};

// ===========================================================
// 🔌 Socket Connection Handler
// ===========================================================
io.on("connection", (socket: Socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // --- Common Join Logic (Rider/Driver join user-specific room) ---
  socket.on("user:join", (data: UserJoinData) => {
    console.log(`👤 ${data.type} is attempting to join room: ${data.userId}`);
    socket.join(data.userId);
    console.log(`🚪 Joined user room: ${data.userId}`);

    if (data.type === "driver") {
      socket.join("drivers");
      console.log("🚕 Driver also joined 'drivers' room.");
    }
    console.log(`✅ ${data.type} joined successfully.`);
  });

  // --- New Ride Request ---
  socket.on("ride:request", async (rideRequestData: RideRequestData) => {
    console.log(`📲 New ride request received from rider:`, rideRequestData);

    const { rideRequestId, roomToken, riderId } = rideRequestData;

    // 1️⃣ Rider joins the new ride room
    socket.join(roomToken);
    console.log(`🔗 Rider joining ride room with roomToken: ${roomToken}`);

    try {
      // 2️⃣ Set initial status in cache
      await updateRideInRedis(roomToken, {
        ...rideRequestData,
        status: "requested",
        createdAt: Date.now(),
      });

      // 3️⃣ Emit the status to the roomToken room
      io.to(roomToken).emit("ride:requested", rideRequestData);
      console.log(`📢 Broadcasted status 'requested' to room ${roomToken}.`);

      // 4️⃣ Find and notify online drivers
      const driverKeys = await redis.keys("driver:*");
      const onlineDrivers: { id: string; socketId: string }[] = [];

      for (const key of driverKeys) {
        const driver = await redis.hgetall(key);

        if (!driver) {
          console.log("::: driver is null");
          return;
        }

        // DEBUGGING: Log the driver data we retrieve from cache
        console.log(`[DEBUG] Checking Driver Key: ${key}, Data:`, driver);

        if (5 == 5) {
          // if (String(driver?.online) === "true" && driver.socketId) {
          // if (driver?.online === "true" && driver.socketId) {
          onlineDrivers.push({
            id: key.replace("driver:", ""),
            socketId: driver.socketId as string,
          });
        }
      }

      if (onlineDrivers.length > 0) {
        for (const { id, socketId } of onlineDrivers) {
          io.to(socketId).emit("ride:requested", rideRequestData);
          console.log(`📡 Ride request sent to driver ${id}`);
        }

        // 5️⃣ Start timeout for this ride request
        const timer = setTimeout(async () => {
          console.log(`⏰ Ride request ${rideRequestId} timed out!`);

          const timeoutPayload = {
            rideRequestId,
            roomToken,
            message: "No driver accepted in time",
          };

          io.to(riderId).emit("ride:timeout", timeoutPayload); // Notify the individual rider
          io.to(roomToken).emit("ride:timeout", timeoutPayload); // Notify the ride room

          // Update cache status to timedOut
          await updateRideInRedis(roomToken, { status: "timedOut" });

          pendingRideRequests.delete(rideRequestId);
        }, RIDE_TIMEOUT_MS);

        pendingRideRequests.set(rideRequestId, timer);
      } else {
        console.log("⚠️ No online drivers found for this ride request");
        // NOTE: No specific event sent to rider if no drivers are found immediately,
        // they rely on the timeout event for "no acceptance".
      }
    } catch (error) {
      console.error("❌ Error processing ride:request:", error);
    }
  });

  // --- Driver Accepts Ride ---
  socket.on("ride:accept", async (data: RideAcceptData) => {
    const { rideRequestId, roomToken, driverId } = data;
    if (!roomToken) {
      console.error("❌ ERROR: roomToken is missing in ride:accept event.");
      return;
    }

    console.log("💚 Ride ACCEPT event received for room:", roomToken);

    try {
      // 1️⃣ Clear the timeout
      const timer = pendingRideRequests.get(rideRequestId);
      if (timer) {
        clearTimeout(timer);
        pendingRideRequests.delete(rideRequestId);
        console.log(`🧹 Cleared timeout for request ${rideRequestId}`);
      }

      // 2️⃣ Driver joins the ride room
      socket.join(roomToken);
      console.log(`🚗 Driver socket ${socket.id} joined room: ${roomToken}`);

      // 3️⃣ Notify rider and driver using the dedicated roomToken
      const acceptedPayload = {
        rideId: data.rideId,
        driverLocation: data.driverLocation,
        roomToken: roomToken,
      };
      io.to(roomToken).emit("ride:accepted", acceptedPayload);
      console.log(`✉️ Sent 'ride:accepted' to ride room: ${roomToken}`);

      // 4️⃣ Update cache
      await updateRideInRedis(roomToken, { status: "accepted", driverId });
    } catch (error) {
      console.error("❌ ERROR in ride:accept handler:", error);
    }
  });

  // --- Common Ride Room Join (for re-entry or general join) ---
  socket.on("ride:join", (data: RideRoomData) => {
    if (!data.roomToken) {
      console.error("❌ ERROR: roomToken is missing in ride join event.");
      return;
    }
    socket.join(data.roomToken);
    console.log(`✅ ${socket.id} joined ride room: ${data.roomToken}`);
  });

  // --- Driver Location Updates ---
  socket.on("driver:location", async (data: DriverLocationData) => {
    if (!data.roomToken) {
      console.error("❌ ERROR: roomToken is missing in driver:location event.");
      return;
    }

    try {
      // Update cache
      await updateRideInRedis(data.roomToken, {
        lastDriverLocation: JSON.stringify(data.location),
      });

      // Broadcast to ride room
      io.to(data.roomToken).emit("ride:driverLocation", data.location);
    } catch (error) {
      console.error("❌ Error processing driver:location:", error);
    }
  });

  // --- Ride Status Updates ---
  socket.on("ride:status", async (data: RideStatusData) => {
    if (!data.roomToken) {
      console.error("❌ ERROR: roomToken is missing in ride:status event.");
      return;
    }

    console.log(
      `🔄 Ride status update for ${data.roomToken}: New status -> ${data.status}`
    );

    try {
      // Update cache
      await updateRideInRedis(data.roomToken, { status: data.status });

      // Broadcast to ride room
      io.to(data.roomToken).emit("ride:status", data.status);
      console.log("✅ Status broadcast complete.");
    } catch (error) {
      console.error(
        `❌ ERROR updating ride status for ${data.roomToken}:`,
        error
      );
    }
  });

  // --- Cancel Ride ---
  socket.on("ride:cancel", async (data: RideCancelData) => {
    if (!data.roomToken) {
      console.error("❌ ERROR: roomToken is missing in ride:cancel event.");
      return;
    }

    try {
      // Update Redis
      await updateRideInRedis(data.roomToken, {
        status: "cancelled",
        lastCancelled: JSON.stringify(data),
      });

      // Broadcast cancellation
      io.to(data.roomToken).emit("ride:cancelled", data);
      console.log(
        `❌ Ride cancelled broadcasted in ride room: ${data.roomToken}`
      );
    } catch (error) {
      console.error("❌ Error processing ride cancellation:", error);
    }
  });

  // --- Reconnect Logic ---
  socket.on("user:reconnect", async (data: UserReconnectData) => {
    console.log("User reconnecting:", data);
    const { userId, type, roomToken } = data;

    // Rejoin standard rooms
    socket.join(userId);
    if (type === "driver") socket.join("drivers");

    if (roomToken) {
      socket.join(roomToken);
      console.log(`🚪 Rejoined room: ${roomToken}`);

      try {
        const rideData = await redis.hgetall(`ride:${roomToken}`);

        if (rideData && Object.keys(rideData).length > 0) {
          // Emit last known state
          if (rideData.lastCancelled) {
            socket.emit(
              "ride:cancelled",
              JSON.parse(rideData.lastCancelled as string)
            );
          } else if (rideData.status === "requested") {
            socket.emit("ride:requested", {
              rideRequestId: rideData.rideRequestId,
              riderId: rideData.riderId,
              roomToken: rideData.roomToken,
            });
          } else if (rideData.status) {
            socket.emit("ride:status", rideData.status);
          }

          if (rideData.lastDriverLocation) {
            socket.emit(
              "ride:driverLocation",
              JSON.parse(rideData.lastDriverLocation as string)
            );
          }
        }
      } catch (error) {
        console.error("Error fetching last ride events on reconnect:", error);
      }
    }
  });

  // --- Driver Comes Online ---
  socket.on("driver:online", async (data: DriverToggleOnlineData) => {
    if (!data.driverId) return;

    console.log(`🟢 Driver online: ${data.driverId}`);
    socket.join("drivers");
    try {
      await updateDriverStatusInRedis(data.driverId, true, socket.id);
    } catch (error) {
      console.error(`❌ Error setting driver online status:`, error);
    }
  });

  // --- Driver Goes Offline Manually ---
  socket.on("driver:offline", async (data: DriverToggleOnlineData) => {
    if (!data.driverId) return;

    console.log(`🔴 Driver offline: ${data.driverId}`);
    socket.leave("drivers");
    try {
      await updateDriverStatusInRedis(data.driverId, false, socket.id);
    } catch (error) {
      console.error(`❌ Error setting driver offline status:`, error);
    }
  });

  // --- Automatic Disconnect Handler ---
  socket.on("disconnect", async () => {
    console.log(`🚪❌ User disconnected: ${socket.id}`);

    try {
      // Find driver by socketId and mark them offline
      const driverKeys = await redis.keys("driver:*");

      for (const key of driverKeys) {
        const driver = await redis.hgetall(key);
        if (driver?.socketId === socket.id) {
          const driverId = key.replace("driver:", "");

          await updateDriverStatusInRedis(driverId, false, socket.id);
          console.log(
            `📣 Driver ${driverId} automatically marked offline on disconnect`
          );
          break;
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
const PORT = 3000;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
