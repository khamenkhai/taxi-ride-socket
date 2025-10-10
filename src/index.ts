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

// ---------------- Event Interfaces ----------------
interface RideStatusUpdate {
  rideId: string;
  status: Ride["status"];
  timestamp: number;
  previousStatus?: Ride["status"];
}

interface RideLocationUpdate {
  rideId: string;
  location: Location;
  timestamp: number;
  speed?: number;
  heading?: number;
}

interface RideDriverUpdate {
  rideId: string;
  driverId: string;
  driverInfo?: any;
  timestamp: number;
}

interface RideDestinationUpdate {
  rideId: string;
  destinationIndex: number;
  status: "pending" | "completed";
  destination: Destination;
  timestamp: number;
}

interface RideETAUpdate {
  rideId: string;
  eta: number; // in minutes
  destinationIndex: number;
  timestamp: number;
}

// ---------------- Memory Storage ----------------
const drivers: Record<string, Driver> = {};
const rides: Record<string, Ride> = {};
const rideTimers: Record<string, NodeJS.Timeout> = {};
const locationThrottle: Record<string, number> = {};
const rideLocks: Set<string> = new Set();

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

// ---------------- Event Emitters ----------------
function emitRideStatus(rideId: string, status: Ride["status"], previousStatus?: Ride["status"]) {
  const ride = rides[rideId];
  if (!ride) return;

  const update: RideStatusUpdate = {
    rideId,
    status,
    previousStatus,
    timestamp: Date.now()
  };

  if (ride.userId) {
    io.to(ride.userId).emit("ride:status", update);
  }
  if (ride.driverId) {
    io.to(ride.driverId).emit("ride:status", update);
  }

  emojiLog("Status Updated 🔄", update);
}

function emitRideLocation(rideId: string, location: Location) {
  const ride = rides[rideId];
  if (!ride || !ride.userId) return;

  const update: RideLocationUpdate = {
    rideId,
    location,
    timestamp: Date.now()
  };

  // Only send to user (driver knows their own location)
  io.to(ride.userId).emit("ride:location", update);
  
  // Throttled logging to avoid spam
  const now = Date.now();
  if (!locationThrottle[rideId] || now - locationThrottle[rideId] > 5000) {
    emojiLog("Location Updated 📍", { rideId, location });
    locationThrottle[rideId] = now;
  }
}

function emitRideDriver(rideId: string, driverId: string, driverInfo?: any) {
  const ride = rides[rideId];
  if (!ride || !ride.userId) return;

  const update: RideDriverUpdate = {
    rideId,
    driverId,
    driverInfo,
    timestamp: Date.now()
  };

  io.to(ride.userId).emit("ride:driver", update);
  emojiLog("Driver Assigned 👨‍💼", update);
}

function emitRideDestination(rideId: string, destinationIndex: number, destination: Destination) {
  const ride = rides[rideId];
  if (!ride) return;

  const update: RideDestinationUpdate = {
    rideId,
    destinationIndex,
    status: destination.status!,
    destination,
    timestamp: Date.now()
  };

  if (ride.userId) io.to(ride.userId).emit("ride:destination", update);
  if (ride.driverId) io.to(ride.driverId).emit("ride:destination", update);
  
  emojiLog("Destination Updated 🎯", update);
}

function emitRideETA(rideId: string, eta: number, destinationIndex: number = 0) {
  const ride = rides[rideId];
  if (!ride) return;

  const update: RideETAUpdate = {
    rideId,
    eta,
    destinationIndex,
    timestamp: Date.now()
  };

  if (ride.userId) io.to(ride.userId).emit("ride:eta", update);
  emojiLog("ETA Updated ⏱", update);
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
  Object.keys(locationThrottle).forEach(rideId => {
    if (now - locationThrottle[rideId] > 60000) {
      delete locationThrottle[rideId];
    }
  });
  
  if (cleaned > 0) {
    emojiLog("Memory Cleanup", { cleanedRides: cleaned, remaining: Object.keys(rides).length });
  }
}

function cleanupCompletedRide(rideId: string) {
  setTimeout(() => {
    if (rides[rideId] && (rides[rideId].status === "completed" || rides[rideId].status === "cancelled")) {
      delete rides[rideId];
      delete locationThrottle[rideId];
      emojiLog("Ride Cleaned Up", { rideId });
    }
  }, 300000);
}

// Start cleanup interval
setInterval(cleanupOldRides, 300000);
setInterval(() => {
  console.log(`📊 Memory Stats - Rides: ${Object.keys(rides).length}, Drivers: ${Object.keys(drivers).length}, Locks: ${rideLocks.size}`);
}, 60000);

// ---------------- Socket Events ----------------
io.on("connection", (socket) => {
  emojiLog("Client Connected", { socketId: socket.id });

  // Resync active rides on connection with specific events
  Object.values(rides).forEach(ride => {
    if (ride.status !== "completed" && ride.status !== "cancelled") {
      if (ride.userId) {
        socket.to(ride.userId).emit("ride:status", {
          rideId: ride.rideId,
          status: ride.status,
          timestamp: Date.now()
        });
        if (ride.driverLocation) {
          socket.to(ride.userId).emit("ride:location", {
            rideId: ride.rideId,
            location: ride.driverLocation,
            timestamp: Date.now()
          });
        }
      }
      if (ride.driverId) {
        socket.to(ride.driverId).emit("ride:status", {
          rideId: ride.rideId,
          status: ride.status,
          timestamp: Date.now()
        });
      }
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

      // Sync active ride with specific events
      const activeRide = Object.values(rides).find(
        (r) => r.driverId === driverId && ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      
      if (activeRide) {
        socket.emit("ride:status", {
          rideId: activeRide.rideId,
          status: activeRide.status,
          timestamp: Date.now()
        });
        
        if (activeRide.destinations) {
          activeRide.destinations.forEach((dest, index) => {
            socket.emit("ride:destination", {
              rideId: activeRide.rideId,
              destinationIndex: index,
              status: dest.status!,
              destination: dest,
              timestamp: Date.now()
            });
          });
        }
      }
      
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

      // Sync active ride with specific events
      const activeRide = Object.values(rides).find(
        (r) => r.userId === userId && ["requested", "accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      
      if (activeRide) {
        socket.emit("ride:status", {
          rideId: activeRide.rideId,
          status: activeRide.status,
          timestamp: Date.now()
        });
        
        if (activeRide.driverId) {
          socket.emit("ride:driver", {
            rideId: activeRide.rideId,
            driverId: activeRide.driverId,
            timestamp: Date.now()
          });
        }
        
        if (activeRide.driverLocation) {
          socket.emit("ride:location", {
            rideId: activeRide.rideId,
            location: activeRide.driverLocation,
            timestamp: Date.now()
          });
        }
        
        if (activeRide.destinations) {
          activeRide.destinations.forEach((dest, index) => {
            socket.emit("ride:destination", {
              rideId: activeRide.rideId,
              destinationIndex: index,
              status: dest.status!,
              destination: dest,
              timestamp: Date.now()
            });
          });
        }
      }
      
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

      const previousStatus = ride.status;
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
      emitRideStatus(ride.rideId, "requested", previousStatus);
      emojiLog("New Ride Requested 🚕", { rideId: ride.rideId, userId: ride.userId });

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

      const previousStatus = ride.status;
      ride.status = "accepted";
      ride.driverId = driverId;
      if (driverLocation) ride.driverLocation = { lat: driverLocation.lat, lng: driverLocation.lng };

      finalizeRide(rideId);
      
      // Emit specific events
      emitRideStatus(rideId, "accepted", previousStatus);
      emitRideDriver(rideId, driverId);
      if (driverLocation) {
        emitRideLocation(rideId, driverLocation);
      }

      emojiLog("Ride Accepted ✅", { rideId, driverId });

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
      
      const previousStatus = ride.status;
      ride.status = "driverArrived";
      
      emitRideStatus(rideId, "driverArrived", previousStatus);
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
      
      const previousStatus = ride.status;
      ride.status = "inProgress";
      
      emitRideStatus(rideId, "inProgress", previousStatus);
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
      emitRideDestination(rideId, idx, ride.destinations[idx]);

      if (idx < ride.destinations.length - 1) {
        ride.currentIndex = idx + 1;
        emojiLog("Destination Completed 🎯", { rideId, destinationIndex: idx });
      } else {
        const previousStatus = ride.status;
        ride.status = "completed";
        emitRideStatus(rideId, "completed", previousStatus);
        emojiLog("All Destinations Completed 🎉", { rideId });
        cleanupCompletedRide(rideId);
      }
      
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

      const previousStatus = ride.status;
      ride.status = "cancelled";
      finalizeRide(rideId);
      cleanupCompletedRide(rideId);

      emitRideStatus(rideId, "cancelled", previousStatus);
      emojiLog("Ride Cancelled ❌", { rideId, userId });
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error cancelRide", err);
      if (callback) callback({ success: false, error: "Cancel failed" });
    }
  });

  // Update driver location - NOW MUCH FASTER!
  socket.on("updateLocation", ({ rideId, lat, lng }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride) {
        if (callback) callback({ success: false, error: "Ride not found" });
        return;
      }

      const now = Date.now();
      // Reduced throttle for better real-time feel (from 500ms to 100ms)
      if (locationThrottle[rideId] && now - locationThrottle[rideId] < 100) {
        if (callback) callback({ success: false, error: "Throttled" });
        return;
      }

      const newLocation = { lat, lng };
      ride.driverLocation = newLocation;
      
      // Emit location separately - much smaller payload
      emitRideLocation(rideId, newLocation);
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error updateLocation", err);
      if (callback) callback({ success: false, error: "Update failed" });
    }
  });

  // Update ETA
  socket.on("updateETA", ({ rideId, eta, destinationIndex }, callback) => {
    try {
      const ride = rides[rideId];
      if (!ride) {
        if (callback) callback({ success: false, error: "Ride not found" });
        return;
      }

      emitRideETA(rideId, eta, destinationIndex);
      
      if (callback) callback({ success: true });
    } catch (err) { 
      console.error("❌ Error updateETA", err);
      if (callback) callback({ success: false, error: "ETA update failed" });
    }
  });

  // Sync ride
  socket.on("syncRide", ({ driverId }, callback) => {
    try {
      const ride = Object.values(rides).find(
        (r) => r.driverId === driverId && ["accepted", "driverArrived", "inProgress"].includes(r.status!)
      );
      
      if (ride) {
        // Emit all relevant events for sync
        socket.emit("ride:status", {
          rideId: ride.rideId,
          status: ride.status,
          timestamp: Date.now()
        });
        
        if (ride.destinations) {
          ride.destinations.forEach((dest, index) => {
            socket.emit("ride:destination", {
              rideId: ride.rideId,
              destinationIndex: index,
              status: dest.status!,
              destination: dest,
              timestamp: Date.now()
            });
          });
        }
        
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

// ---------------- Server Start ----------------
const PORT = 3000;
const HOST = process.env.HOST || "0.0.0.0";

process.on('uncaughtException', (error) => {
  console.error('🚨 Prototype Crash Prevented:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});

httpServer.listen(PORT, HOST, () => {
  emojiLog("Server Running 🚀", { host: HOST, port: PORT });
  console.log("\n🎯 Multiple Channel Architecture Active!");
  console.log("📡 Available Events:");
  console.log("   • ride:status - Ride status changes");
  console.log("   • ride:location - Real-time location updates");
  console.log("   • ride:driver - Driver assignment");
  console.log("   • ride:destination - Destination progress");
  console.log("   • ride:eta - ETA updates");
  console.log("\n⚡ Location updates now much faster (100ms throttle)!");
});

export { io, httpServer };