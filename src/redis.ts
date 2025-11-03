import express from "express";
import http from "http";
import { Server } from "socket.io";
import Redis from "ioredis";

// ===========================================================
// ⚡ Redis Setup
// ===========================================================
const redis = new Redis(); // default localhost:6379
console.log("✅ Redis client initialized.");

// ===========================================================
// Express + Socket.IO Setup
// ===========================================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
console.log("🌐 Socket.IO Server and CORS configured.");

// ===========================================================
// 🔌 Socket Connection Handler
// ===========================================================
io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // -----------------------------------------------------------
  // User joins their room
  // -----------------------------------------------------------
  socket.on("user:join", (data: { userId: string; type: "rider" | "driver" }) => {
    socket.join(data.userId);
    if (data.type === "driver") socket.join("drivers");
    console.log(`✅ ${data.type} joined room: ${data.userId}`);
  });

  // -----------------------------------------------------------
  // Ride request from rider
  // -----------------------------------------------------------
  socket.on("ride:request", async (rideRequestData) => {
    console.log("📲 New ride request:", rideRequestData);

    // Store ride request in Redis
    const rideRequestId = rideRequestData.rideRequestId || `rideReq:${Date.now()}`;
    await redis.hmset(`rideRequest:${rideRequestId}`, rideRequestData);

    // Notify all drivers
    socket.to("drivers").emit("ride:requested", rideRequestData);
    console.log("🚀 Ride request sent to drivers");
  });

  // -----------------------------------------------------------
  // Driver accepts ride
  // -----------------------------------------------------------
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
        // 1️⃣ Driver joins ride room
        socket.join(data.rideId);

        // 2️⃣ Save ride info in Redis
        await redis.hmset(`ride:${data.rideId}`, {
          rideId: data.rideId,
          driverId: data.driverId,
          riderId: data.riderId,
          status: "accepted",
          lastAccepted: JSON.stringify(data),
        });

        // 3️⃣ Notify rider and driver
        const payload = {
          rideId: data.rideId,
          driverLocation: data.driverLocation,
        };

        io.to(data.riderId).emit("ride:accepted", payload);
        io.to(data.driverId).emit("ride:accepted", payload);
        socket.emit("ride:accepted", payload);

        console.log(`💚 Ride accepted: ${data.rideId}`);
      } catch (error) {
        console.error("❌ Error in ride:accept:", error);
      }
    }
  );

  // -----------------------------------------------------------
  // Join ride room
  // -----------------------------------------------------------
  socket.on("ride:join", (data: { rideId: string }) => {
    socket.join(data.rideId);
    console.log(`✅ Joined ride room: ${data.rideId}`);
  });

  // -----------------------------------------------------------
  // Driver location update
  // -----------------------------------------------------------
  socket.on("driver:location", async (data: { rideId: string; location: { lat: number; lng: number } }) => {
    await redis.hmset(`ride:${data.rideId}`, {
      lastDriverLocation: JSON.stringify(data.location),
    });

    io.to(data.rideId).emit("ride:driverLocation", data.location);
  });

  // -----------------------------------------------------------
  // Ride status update
  // -----------------------------------------------------------
  socket.on(
    "ride:status",
    async (data: { rideId: string; status: "driverArrived" | "inProgress" | "completed" | "cancelled" }) => {
      await redis.hmset(`ride:${data.rideId}`, {
        status: data.status,
      });
      io.to(data.rideId).emit("ride:status", data.status);
      console.log(`📢 Status '${data.status}' broadcasted for ride ${data.rideId}`);
    }
  );

  // -----------------------------------------------------------
  // Ride cancellation
  // -----------------------------------------------------------
  socket.on(
    "ride:cancel",
    async (data: { rideId: string; cancelledBy: "rider" | "driver"; reason?: string }) => {
      await redis.hmset(`ride:${data.rideId}`, {
        lastCancelled: JSON.stringify(data),
        status: "cancelled",
      });

      // Notify other party
      const rideInfo = await redis.hgetall(`ride:${data.rideId}`);
      const targetRoom = data.cancelledBy === "rider" ? rideInfo.driverId : rideInfo.riderId;
      io.to(targetRoom).emit("ride:cancelled", data);

      console.log(`❌ Ride cancelled by ${data.cancelledBy}: ${data.rideId}`);
    }
  );

  // -----------------------------------------------------------
  // User reconnect
  // -----------------------------------------------------------
  socket.on(
    "user:reconnect",
    async (data: { userId: string; type: "rider" | "driver"; rideId?: string }) => {
      socket.join(data.userId);
      if (data.type === "driver") socket.join("drivers");

      if (data.rideId) {
        const rideData = await redis.hgetall(`ride:${data.rideId}`);
        if (rideData.status) socket.emit("ride:status", rideData.status);
        if (rideData.lastDriverLocation) socket.emit("ride:driverLocation", JSON.parse(rideData.lastDriverLocation));
        if (rideData.lastAccepted) socket.emit("ride:accepted", JSON.parse(rideData.lastAccepted));
        if (rideData.lastCancelled) socket.emit("ride:cancelled", JSON.parse(rideData.lastCancelled));
      }
    }
  );

  // -----------------------------------------------------------
  // Disconnect
  // -----------------------------------------------------------
  socket.on("disconnect", () => {
    console.log(`🚪 User disconnected: ${socket.id}`);
  });
});

// ===========================================================
// 🚀 Start server
// ===========================================================
const PORT = 3000;
const HOST = "192.168.100.76";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});
