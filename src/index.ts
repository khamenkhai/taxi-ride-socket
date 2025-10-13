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

// Add these interfaces
interface User {
  id: string;
  type: 'rider' | 'driver';
  socketId: string;
}

// Add in-memory storage (replace with DB in production)
const activeRides = new Map<string, Ride>();
const connectedUsers = new Map<string, User>();

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // User authentication and room joining
  socket.on("user:join", (user: User) => {
    connectedUsers.set(user.id, { ...user, socketId: socket.id });
    socket.join(user.id);
    
    if (user.type === 'driver') {
      socket.join('drivers');
      console.log(`Driver ${user.id} joined drivers room`);
    }
  });

  // Rider requests a ride - FIXED: Only notify drivers
  socket.on("ride:request", (ride: Ride) => {
    console.log("New ride request:", ride);
    ride.status = "requested";
    ride.createdAt = Date.now();
    activeRides.set(ride.rideId, ride);
    
    // Only notify drivers, not all clients
    socket.to('drivers').emit("ride:requested", ride);
  });

  // Driver accepts ride - FIXED: Proper room targeting
  socket.on("ride:accept", (ride: Ride) => {
    const existingRide = activeRides.get(ride.rideId);
    if (!existingRide) return;

    existingRide.status = "accepted";
    existingRide.driverId = ride.driverId;
    activeRides.set(ride.rideId, existingRide);

    // Notify specific rider and driver
    io.to(existingRide.userId).emit("ride:accepted", existingRide);
    io.to(ride.driverId!).emit("ride:accepted", existingRide);
  });

  // Add ride status validation
  socket.on("ride:driverArrived", (data: { rideId: string }) => {
    const ride = activeRides.get(data.rideId);
    if (ride && ride.status === "accepted") {
      ride.status = "driverArrived";
      io.to(ride.userId).emit("ride:update", ride);
    }
  });

  // Add proper cleanup for completed/cancelled rides
  socket.on("ride:complete", (rideId: string) => {
    const ride = activeRides.get(rideId);
    if (ride) {
      ride.status = "completed";
      io.to(ride.userId).emit("ride:update", ride);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", ride);
      activeRides.delete(rideId);
    }
  });

  socket.on("ride:cancel", (data: { rideId: string; reason?: string }) => {
    const ride = activeRides.get(data.rideId);
    if (ride) {
      ride.status = "cancelled";
      io.to(ride.userId).emit("ride:cancelled", { ...ride, reason: data.reason });
      if (ride.driverId) io.to(ride.driverId).emit("ride:cancelled", { ...ride, reason: data.reason });
      activeRides.delete(data.rideId);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
    // Clean up user from connectedUsers
    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        connectedUsers.delete(userId);
        break;
      }
    }
  });
});