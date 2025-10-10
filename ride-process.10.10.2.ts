// backend.ts
import { Server } from "socket.io";
import http from "http";
import * as dotenv from "dotenv";
dotenv.config();


const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// ---------------- Interfaces ----------------
interface Location {
  lat: number;
  lng: number;
  address?: string;
}

interface Destination extends Location {
  status?: "pending" | "completed";
}

interface Ride {
  rideId: string;
  userId: string;
  driverId?: string;
  status?: "requested" | "accepted" | "driverArrived" | "inProgress" | "completed" | "cancelled";
  driverLocation?: Location;
  pickupLocation?: Location;
  destinations?: Destination[];
  currentIndex?: number;
  createdAt?: number;
}

interface Driver {
  driverId: string;
  socketId: string;
  online: boolean;
}

// ---------------- Memory Storage ----------------
const drivers: Record<string, Driver> = {};
const rides: Record<string, Ride> = {};
const rideTimers: Record<string, NodeJS.Timeout> = {};
const updateThrottle: Record<string, number> = {};
const rideLocks: Set<string> = new Set(); // Prevent race conditions

// ---------------- Helpers ----------------
const log = (...args: any[]) => {
  if (process.env.DEBUG === "true") console.log(...args);
};

function emojiLog(process: string, data?: any) {
  console.log(`🚀 [${process}]`, data ? JSON.stringify(data, null, 2) : "");
}

function finalizeRide(rideId: string) {
  if (rideTimers[rideId]) {
    clearTimeout(rideTimers[rideId]);
    delete rideTimers[rideId];
    emojiLog("Timer Cleared", { rideId });
  }
  rideLocks.delete(rideId);
}

function validateRidePayload(ride: any): ride is Ride {
  return ride && typeof ride.rideId === "string" && typeof ride.userId === "string";
}

function acquireRideLock(rideId: string): boolean {
  if (rideLocks.has(rideId)) return false;
  rideLocks.add(rideId);
  return true;
}

function releaseRideLock(rideId: string) {
  rideLocks.delete(rideId);
}

// ---------------- Memory Management ----------------
function cleanupOldRides() {
  const hourAgo = Math.floor((Date.now() - 3600000) / 1000);
  let cleaned = 0;
  
  Object.keys(rides).forEach(rideId => {
    const ride = rides[rideId];
    if (ride.createdAt && ride.createdAt < hourAgo) {
      delete rides[rideId];
      finalizeRide(rideId);
      cleaned++;
    }
  });
  
  // Cleanup old throttle entries
  const now = Date.now();
  Object.keys(updateThrottle).forEach(rideId => {
    if (now - updateThrottle[rideId] > 60000) {
      delete updateThrottle[rideId];
    }
  });
  
  if (cleaned > 0) {
    emojiLog("Memory Cleanup", { cleanedRides: cleaned, remaining: Object.keys(rides).length });
  }
}

function cleanupCompletedRide(rideId: string) {
  // Keep completed rides for 5 minutes then cleanup
  setTimeout(() => {
    if (rides[rideId] && (rides[rideId].status === "completed" || rides[rideId].status === "cancelled")) {
      delete rides[rideId];
      delete updateThrottle[rideId];
      emojiLog("Ride Cleaned Up", { rideId });
    }
  }, 300000); // 5 minutes
}

// Start cleanup interval
setInterval(cleanupOldRides, 300000); // Every 5 minutes

// Memory monitoring
setInterval(() => {
  console.log(`📊 Memory Stats - Rides: ${Object.keys(rides).length}, Drivers: ${Object.keys(drivers).length}, Locks: ${rideLocks.size}`);
}, 60000);

// ---------------- Socket Events ----------------
io.on("connection", (socket) => {
  emojiLog("Client Connected", { socketId: socket.id });

  // Resync active rides on connection
  Object.values(rides).forEach(ride => {
    if (ride.status !== "completed" && ride.status !== "cancelled") {
      if (ride.userId) socket.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      if (ride.driverId) socket.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
    }
  });

  // ----- Driver registers -----
  socket.on("registerDriver", (payload, callback) => {
    try {
      const { driverId } = payload;
      if (!driverId) {
        if (callback) callback({ success: false, error: "Missing driverId" });
        return;
      }
      
      drivers[driverId] = { driverId, socketId: socket.id, online: true };
      socket.join(driverId);
      io.emit("driverStatusChanged", { driverId, online: true });
      emojiLog("Driver Registered ✅", { driverId });

      const activeRide = Object.values(rides).find(
        (r) =>
          r.driverId === driverId &&
          ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      if (activeRide) socket.emit(`ride_${activeRide.rideId}`, activeRide);
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error registerDriver", err);
      if (callback) callback({ success: false, error: "Registration failed" });
    }
  });

  // ----- User registers -----
  socket.on("registerUser", (payload, callback) => {
    try {
      const { userId } = payload;
      if (!userId) {
        if (callback) callback({ success: false, error: "Missing userId" });
        return;
      }
      
      socket.join(userId);
      emojiLog("User Registered 📝", { userId });

      const activeRide = Object.values(rides).find(
        (r) =>
          r.userId === userId &&
          ["requested", "accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      if (activeRide) socket.emit(`ride_${activeRide.rideId}`, activeRide);
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error registerUser", err);
      if (callback) callback({ success: false, error: "Registration failed" });
    }
  });

  // ----- Driver online/offline -----
  socket.on("driverOffline", ({ driverId }, callback) => {
    try {
      const driver = drivers[driverId];
      if (driver) {
        driver.online = false;
        io.emit("driverStatusChanged", { driverId, online: false });
        emojiLog("Driver Offline 🛑", { driverId });
      }
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error driverOffline", err);
      if (callback) callback({ success: false, error: "Operation failed" });
    }
  });

  socket.on("driverOnline", ({ driverId }, callback) => {
    try {
      const driver = drivers[driverId];
      if (driver) {
        driver.online = true;
        io.emit("driverStatusChanged", { driverId, online: true });
        emojiLog("Driver Online ✅", { driverId });
      }
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error driverOnline", err);
      if (callback) callback({ success: false, error: "Operation failed" });
    }
  });

  // ----- Disconnect -----
  socket.on("disconnect", () => {
    try {
      const driver = Object.values(drivers).find((d) => d.socketId === socket.id);
      if (driver) {
        driver.online = false;
        io.emit("driverStatusChanged", { driverId: driver.driverId, online: false });
        emojiLog("Driver Disconnected ❌", { driverId: driver.driverId });
      }
      emojiLog("Client Disconnected ❌", { socketId: socket.id });
    } catch (err) { console.error("❌ Error disconnect", err); }
  });

  // ---------------- Rides ----------------

  // Request ride
  socket.on("rideRequested", (ride, callback) => {
    try {
      if (!validateRidePayload(ride)) {
        if (callback) callback({ success: false, error: "Invalid ride payload" });
        return;
      }

      ride.status = "requested";
      ride.createdAt = Math.floor(Date.now() / 1000);

      if (Array.isArray(ride.destinations)) {
        ride.destinations = ride.destinations.slice(0, 4).map((d: Destination) => ({
          ...d,
          status: "pending",
        }));
        ride.currentIndex = 0;
      }

      rides[ride.rideId] = ride;
      emojiLog("New Ride Requested 🚕", ride);

      const candidates = Object.values(drivers)
        .filter((d) => d.online && !Object.values(rides).some(
          (r) => r.driverId === d.driverId && ["accepted", "driverArrived", "inProgress"].includes(r.status!)
        ))
        .slice(0, 3);

      candidates.forEach((driver) => {
        io.to(driver.driverId).emit("rideRequested", ride);
        emojiLog("Ride Sent to Driver 📤", { rideId: ride.rideId, driverId: driver.driverId });
      });

      if (candidates.length > 0 && !rideTimers[ride.rideId]) {
        rideTimers[ride.rideId] = setTimeout(() => {
          emojiLog("Ride Timeout ⏱", { rideId: ride.rideId });
          candidates.forEach((d) => io.to(d.driverId).emit("rideTimeout", { rideId: ride.rideId }));
          delete rideTimers[ride.rideId];
        }, 10000);
      }

      if (callback) callback({ success: true, candidates: candidates.length });
    } catch (err) { 
      console.error("❌ Error rideRequested", err);
      if (callback) callback({ success: false, error: "Ride request failed" });
    }
  });

  // Accept ride
  socket.on("acceptRide", ({ rideId, driverId, driverLocation }, callback) => {
    try {
      if (!acquireRideLock(rideId)) {
        if (callback) callback({ success: false, error: "Ride already being processed" });
        return;
      }

      const ride = rides[rideId];
      if (!ride || ride.status !== "requested") {
        releaseRideLock(rideId);
        if (callback) callback({ success: false, error: "Ride not available" });
        return;
      }

      ride.status = "accepted";
      ride.driverId = driverId;
      if (driverLocation) ride.driverLocation = { lat: driverLocation.lat, lng: driverLocation.lng };

      finalizeRide(rideId);
      io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      io.to(driverId).emit(`ride_${ride.rideId}`, ride);
      emojiLog("Ride Accepted ✅", { rideId, driverId, driverLocation });

      if (callback) callback({ success: true, ride });
    } catch (err) { 
      console.error("❌ Error acceptRide", err);
      releaseRideLock(rideId);
      if (callback) callback({ success: false, error: "Accept ride failed" });
    }
  });

  // Driver arrived
  socket.on("driverArrived", ({ rideId }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride || ride.status !== "accepted") {
        if (callback) callback({ success: false, error: "Invalid ride state" });
        return;
      }
      
      ride.status = "driverArrived";
      io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
      emojiLog("Driver Arrived 📍", { rideId });
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error driverArrived", err);
      if (callback) callback({ success: false, error: "Operation failed" });
    }
  });

  // Start ride
  socket.on("startRide", ({ rideId }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride || ride.status !== "driverArrived") {
        if (callback) callback({ success: false, error: "Invalid ride state" });
        return;
      }
      
      ride.status = "inProgress";
      io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
      emojiLog("Ride Started 🏁", { rideId });
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error startRide", err);
      if (callback) callback({ success: false, error: "Operation failed" });
    }
  });

  // Complete destination
  socket.on("completeDestination", ({ rideId }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride || ride.status !== "inProgress") {
        if (callback) callback({ success: false, error: "Invalid ride state" });
        return;
      }

      const idx = ride.currentIndex ?? 0;
      if (!ride.destinations || idx >= ride.destinations.length) {
        if (callback) callback({ success: false, error: "No destinations available" });
        return;
      }

      ride.destinations[idx].status = "completed";

      if (idx < ride.destinations.length - 1) {
        ride.currentIndex = idx + 1;
        emojiLog("Destination Completed 🎯", { rideId, destinationIndex: idx });
      } else {
        ride.status = "completed";
        emojiLog("All Destinations Completed 🎉", { rideId });
        cleanupCompletedRide(rideId);
      }

      io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
      
      if (callback) callback({ success: true, currentIndex: ride.currentIndex, completed: ride.status === "completed" });
    } catch (err) { 
      console.error("❌ Error completeDestination", err);
      if (callback) callback({ success: false, error: "Operation failed" });
    }
  });

  // Cancel ride
  socket.on("cancelRide", ({ rideId, userId }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride || ride.status === "completed") {
        if (callback) callback({ success: false, error: "Ride not found or already completed" });
        return;
      }

      ride.status = "cancelled";
      finalizeRide(rideId);
      cleanupCompletedRide(rideId);

      if (ride.driverId) io.to(ride.driverId).emit(`ride_${ride.rideId}`, ride);
      io.to(userId).emit(`ride_${ride.rideId}`, ride);
      emojiLog("Ride Cancelled ❌", { rideId, userId });
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error cancelRide", err);
      if (callback) callback({ success: false, error: "Cancel failed" });
    }
  });

  // Update driver location
  socket.on("updateLocation", ({ rideId, lat, lng }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride) {
        if (callback) callback({ success: false, error: "Ride not found" });
        return;
      }

      const now = Date.now();
      if (updateThrottle[rideId] && now - updateThrottle[rideId] < 500) {
        if (callback) callback({ success: false, error: "Throttled" });
        return;
      }
      updateThrottle[rideId] = now;

      ride.driverLocation = { lat, lng };
      io.to(ride.userId).emit(`ride_${ride.rideId}`, ride);
      io.to(ride.driverId!).emit(`ride_${ride.rideId}`, ride);
      emojiLog("Driver Location Updated 📍", { rideId, lat, lng });
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error updateLocation", err);
      if (callback) callback({ success: false, error: "Update failed" });
    }
  });

  // Sync ride
  socket.on("syncRide", ({ driverId }, callback) => {
    try {
      const ride = Object.values(rides).find(
        (r) =>
          r.driverId === driverId &&
          ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      if (ride) {
        socket.emit(`ride_${ride.rideId}`, ride);
        if (callback) callback({ success: true, ride });
      } else {
        socket.emit("noActiveRide");
        if (callback) callback({ success: true, ride: null });
      }
      emojiLog("Sync Ride 🔄", { driverId, rideId: ride?.rideId || null });
    } catch (err) { 
      console.error("❌ Error syncRide", err);
      if (callback) callback({ success: false, error: "Sync failed" });
    }
  });
});

// ---------------- Database Migration Command ----------------
function setupDatabase() {
  console.log(`
🎯 DATABASE SETUP COMMAND:

Run this MongoDB setup in your terminal:

// 1. Start MongoDB (make sure it's installed and running)
// mongod

// 2. Connect to MongoDB
use ride_hailing_db

// 3. Create indexes for better performance
db.rides.createIndex({ rideId: 1 }, { unique: true })
db.rides.createIndex({ userId: 1 })
db.rides.createIndex({ driverId: 1 })
db.rides.createIndex({ status: 1 })
db.rides.createIndex({ createdAt: 1 })

db.drivers.createIndex({ driverId: 1 }, { unique: true })
db.drivers.createIndex({ online: 1 })

// 4. Create collections with validation (optional)
db.createCollection("rides", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["rideId", "userId", "status", "createdAt"],
      properties: {
        rideId: { bsonType: "string" },
        userId: { bsonType: "string" },
        driverId: { bsonType: "string" },
        status: { 
          bsonType: "string",
          enum: ["requested", "accepted", "driverArrived", "inProgress", "completed", "cancelled"]
        },
        createdAt: { bsonType: "number" }
      }
    }
  }
})

db.createCollection("drivers", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["driverId", "online"],
      properties: {
        driverId: { bsonType: "string" },
        socketId: { bsonType: "string" },
        online: { bsonType: "bool" }
      }
    }
  }
})

✅ Database setup complete! Ready to integrate with MongoDB.
  `);
}

// ---------------- Server Start ----------------
const PORT = 3000;
const HOST = process.env.HOST || "0.0.0.0";

// Crash prevention
process.on('uncaughtException', (error) => {
  console.error('🚨 Prototype Crash Prevented:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

httpServer.listen(PORT, HOST, () => {
  emojiLog("Server Running 🚀", { host: HOST, port: PORT });
  console.log("\n💡 To set up MongoDB database later, call: setupDatabase()");
  console.log("📱 Client apps will work WITHOUT any changes needed!\n");
});

// Export for testing
export { io, httpServer, setupDatabase };