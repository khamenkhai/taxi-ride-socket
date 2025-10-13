import express from "express";
import http from "http";
import { Server } from "socket.io";

interface Location {
  lat: number;
  lng: number;
}

interface Destination {
  lat: number;
  lng: number;
  address?: string;
}

interface Ride {
  rideId: string;
  userId: string;
  driverId?: string;
  status?:
    | "requested"
    | "accepted"
    | "driverArrived"
    | "inProgress"
    | "completed"
    | "cancelled";
  driverLocation?: Location;
  pickupLocation?: Location;
  destinations?: Destination[];
  currentIndex?: number;
  createdAt?: number;
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

interface User {
  id: string;
  type: "rider" | "driver";
  socketId: string;
}

const activeRides = new Map<string, Ride>();
const connectedUsers = new Map<string, User>();

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // ===========================================================
  // ✅ User join and room management
  // ===========================================================
  socket.on("user:join", (user: User) => {
    console.log(`👤 User joined:`, user);
    connectedUsers.set(user.id, { ...user, socketId: socket.id });
    socket.join(user.id);

    if (user.type === "driver") {
      socket.join("drivers");
      console.log(`🚗 Driver ${user.id} joined drivers room`);
    }
  });

  // ===========================================================
  // ✅ Rider requests a ride
  // ===========================================================
  socket.on("ride:request", (ride: Ride) => {
    console.log("📲 New ride request received:", ride);
    ride.status = "requested";
    ride.createdAt = Date.now();
    activeRides.set(ride.rideId, ride);

    console.log("📡 Broadcasting to drivers 🚘:", ride);
    socket.to("drivers").emit("ride:requested", ride);
  });

  // ===========================================================
  // ✅ Driver accepts ride
  // ===========================================================
  socket.on("ride:accept", (ride: Ride) => {
    console.log("✅ Ride accepted by driver:", ride);
    const existingRide = activeRides.get(ride.rideId);
    if (!existingRide) {
      console.log("❌ Ride not found:", ride.rideId);
      return;
    }

    existingRide.status = "accepted";
    existingRide.driverId = ride.driverId;
    activeRides.set(ride.rideId, existingRide);

    console.log("📤 Sending ride:accepted to rider and driver:", existingRide);
    io.to(existingRide.userId).emit("ride:accepted", existingRide);
    io.to(ride.driverId!).emit("ride:accepted", existingRide);
  });

  // ===========================================================
  // ✅ Driver arrived
  // ===========================================================
  socket.on("ride:driverArrived", (data: { rideId: string }) => {
    console.log("📍 Driver arrived for ride:", data);
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === "accepted") {
      ride.status = "driverArrived";
      console.log("📤 Notifying rider driver has arrived:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      io.to(ride.driverId || '').emit("ride:update", ride);
    }
  });

  // ===========================================================
  // ✅ Driver starts the ride (In Progress)
  // ===========================================================
  socket.on("ride:inProgress", (data: { rideId: string }) => {
    console.log("🚦 Ride in progress:", data);
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === "driverArrived") {
      ride.status = "inProgress";
      console.log("📤 Updating rider and driver ride status:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", ride);
    }
  });

  // ===========================================================
  // ✅ Ride complete
  // ===========================================================
  socket.on("ride:complete", (rideId: string) => {
    console.log("🏁 Ride completed:", rideId);
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.status = "completed";
      console.log("📤 Notifying both parties of completion:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", ride);
      activeRides.delete(rideId);
    }
  });

  // ===========================================================
  // ✅ Ride cancel
  // ===========================================================
  socket.on("ride:cancel", (data: { rideId: string; reason?: string }) => {
    console.log("🚫 Ride cancelled:", data);
    const ride = activeRides.get(data.rideId);
    if (ride) {
      ride.status = "cancelled";
      console.log("📤 Notifying user and driver of cancellation:", {
        ...ride,
        reason: data.reason,
      });
      io.to(ride.userId).emit("ride:cancelled", {
        ...ride,
        reason: data.reason,
      });
      if (ride.driverId)
        io.to(ride.driverId).emit("ride:cancelled", {
          ...ride,
          reason: data.reason,
        });
      activeRides.delete(data.rideId);
    }
  });

  // ===========================================================
  // 🔁 Auto Sync when user restarts app
  // ===========================================================
  socket.on("user:resync", (userId: string) => {
    console.log(`🔄 Resync requested by ${userId}`);
    const user = connectedUsers.get(userId);
    if (user) {
      user.socketId = socket.id;
      connectedUsers.set(userId, user);
      socket.join(userId);
      if (user.type === "driver") socket.join("drivers");
    }

    const rides = Array.from(activeRides.values()).filter(
      (r) => r.userId === userId || r.driverId === userId
    );
    console.log("📤 Sending active rides on resync:", rides);
    if (rides.length > 0) {
      socket.emit("rides:resync", rides);
    }
  });

  // ===========================================================
  // 📡 Driver Location Update (Realtime tracking)
  // ===========================================================
  socket.on(
    "driver:locationUpdate",
    (data: { driverId: string; location: Location }) => {
      console.log("📍 Driver location update:", data);
      for (const [_, ride] of activeRides) {
        if (ride.driverId === data.driverId && ride.status !== "completed") {
          ride.driverLocation = data.location;
          console.log("📤 Sending location to rider:", {
            driverId: data.driverId,
            location: data.location,
          });
          io.to(ride.userId).emit("ride:driverLocation", {
            driverId: data.driverId,
            location: data.location,
          });
        }
      }
    }
  );

  // ===========================================================
  // ✅ Disconnect cleanup
  // ===========================================================
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        console.log(`🗑️ Removing disconnected user: ${userId}`);
        connectedUsers.delete(userId);
        break;
      }
    }
  });
});


// ===========================================================
// 🚀 Start the server using your Wi-Fi IP address
// ===========================================================
const PORT = 3000;
const HOST = "192.168.100.68"; // 🛑 Replace this with your actual Wi-Fi IP

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
