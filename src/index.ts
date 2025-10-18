import express from "express";
import http from "http";
import { Server } from "socket.io";
import admin from "firebase-admin";

// Initialize Firebase Admin
const serviceAccount = require("../serviceAccountKey.json"); // Replace with your service account path

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

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

// Firestore collections
const ridesCollection = db.collection("rides");
const usersCollection = db.collection("connectedUsers");

const connectedUsers = new Map<string, User>();

async function getActiveRideForUser(userId: string): Promise<Ride | null> {
  const activeStatuses = [
    "requested",
    "accepted",
    "driverArrived",
    "inProgress",
  ];

  const snapshot = await ridesCollection
    .where("status", "in", activeStatuses)
    .where("userId", "==", userId)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    return snapshot.docs[0].data() as Ride;
  }
  return null;
}

async function getActiveRideForDriver(driverId: string): Promise<Ride | null> {
  const activeStatuses = [
    "requested",
    "accepted",
    "driverArrived",
    "inProgress",
  ];

  const snapshot = await ridesCollection
    .where("status", "in", activeStatuses)
    .where("driverId", "==", driverId)
    .limit(1)
    .get();

  if (!snapshot.empty) {
    return snapshot.docs[0].data() as Ride;
  }
  return null;
}

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // ===========================================================
  // ✅ User join and room management
  // ===========================================================
  socket.on("user:join", async (user: User) => {
    console.log(`👤 User joined:`, user);
    connectedUsers.set(user.id, { ...user, socketId: socket.id });
    socket.join(user.id);

    // Store user in Firestore
    await usersCollection.doc(user.id).set(
      {
        ...user,
        socketId: socket.id,
        isConnected: true,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    if (user.type === "driver") {
      socket.join("drivers");
      console.log(`🚗 Driver ${user.id} joined drivers room`);
    }
  });

  // ===========================================================
  // ✅ Rider requests a ride
  // ===========================================================
  socket.on("ride:request", async (ride: Ride) => {
    console.log("📲 New ride request received:", ride);
    ride.status = "requested";
    ride.createdAt = Date.now();

    // Store ride in Firestore
    await ridesCollection.doc(ride.rideId).set(ride);

    console.log("📡 Broadcasting to drivers 🚘:", ride);
    socket.to("drivers").emit("ride:requested", ride);
  });

  // ===========================================================
  // ✅ Driver accepts ride
  // ===========================================================
  socket.on("ride:accept", async (ride: Ride) => {
    console.log("✅ Ride accepted by driver:", ride);

    const rideDoc = await ridesCollection.doc(ride.rideId).get();
    if (!rideDoc.exists) {
      console.log("❌ Ride not found:", ride.rideId);
      return;
    }

    const existingRide = rideDoc.data() as Ride;
    existingRide.status = "accepted";
    existingRide.driverId = ride.driverId;

    // Update ride in Firestore
    await ridesCollection.doc(ride.rideId).update({
      status: "accepted",
      driverId: ride.driverId,
    });

    console.log("📤 Sending ride:accepted to rider and driver:", existingRide);
    io.to(existingRide.userId).emit("ride:accepted", existingRide);
    io.to(ride.driverId!).emit("ride:accepted", existingRide);
  });

  // ===========================================================
  // ✅ Driver arrived
  // ===========================================================
  socket.on("ride:driverArrived", async (data: { rideId: string }) => {
    console.log("📍 Driver arrived for ride:", data);

    const rideDoc = await ridesCollection.doc(data.rideId).get();
    if (!rideDoc.exists) return;

    const ride = rideDoc.data() as Ride;
    if (ride && ride.status === "accepted") {
      // Update ride status in Firestore
      await ridesCollection.doc(data.rideId).update({
        status: "driverArrived",
      });

      ride.status = "driverArrived";
      console.log("📤 Notifying rider driver has arrived:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      io.to(ride.driverId || "").emit("ride:update", ride);
    }
  });

  // ===========================================================
  // ✅ Driver starts the ride (In Progress)
  // ===========================================================
  socket.on("ride:inProgress", async (data: { rideId: string }) => {
    console.log("🚦 Ride in progress:", data);

    const rideDoc = await ridesCollection.doc(data.rideId).get();
    if (!rideDoc.exists) return;

    const ride = rideDoc.data() as Ride;
    if (ride && ride.status === "driverArrived") {
      // Update ride status in Firestore
      await ridesCollection.doc(data.rideId).update({
        status: "inProgress",
      });

      ride.status = "inProgress";
      console.log("📤 Updating rider and driver ride status:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", ride);
    }
  });

  // ===========================================================
  // ✅ Ride complete
  // ===========================================================
  socket.on("ride:complete", async (rideId: string) => {
    console.log("🏁 Ride completed:", rideId);

    const rideDoc = await ridesCollection.doc(rideId).get();
    if (!rideDoc.exists) return;

    const ride = rideDoc.data() as Ride;
    if (ride) {
      // Update ride status in Firestore
      await ridesCollection.doc(rideId).update({
        status: "completed",
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      ride.status = "completed";
      console.log("📤 Notifying both parties of completion:", ride);
      io.to(ride.userId).emit("ride:update", ride);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", ride);
    }
  });

  // ===========================================================
  // ✅ Ride cancel
  // ===========================================================
  socket.on(
    "ride:cancel",
    async (data: { rideId: string; reason?: string }) => {
      console.log("🚫 Ride cancelled:", data);

      const rideDoc = await ridesCollection.doc(data.rideId).get();
      if (!rideDoc.exists) return;

      const ride = rideDoc.data() as Ride;
      if (ride) {
        // Update ride status in Firestore
        await ridesCollection.doc(data.rideId).update({
          status: "cancelled",
          cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
          cancelReason: data.reason,
        });

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
      }
    }
  );



  // ===========================================================
  // 📡 Driver Location Update (Realtime tracking)
  // ===========================================================
  socket.on(
    "driver:locationUpdate",
    async (data: { driverId: string; location: Location }) => {
      console.log("📍 Driver location update:", data);

      // Get all active rides for this driver
      const ridesSnapshot = await ridesCollection
        .where("driverId", "==", data.driverId)
        .where("status", "in", ["accepted", "driverArrived", "inProgress"])
        .get();

      ridesSnapshot.forEach(async (doc) => {
        const ride = doc.data() as Ride;

        // Update driver location in Firestore
        await ridesCollection.doc(doc.id).update({
          driverLocation: data.location,
        });

        console.log("📤 Sending location to rider:", {
          driverId: data.driverId,
          location: data.location,
        });
        io.to(ride.userId).emit("ride:driverLocation", {
          driverId: data.driverId,
          location: data.location,
        });
      });
    }
  );

  // ===========================================================
  // ✅ Disconnect cleanup
  // ===========================================================
  socket.on("disconnect", async () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    for (const [userId, user] of connectedUsers.entries()) {
      if (user.socketId === socket.id) {
        console.log(`🗑️ Removing disconnected user: ${userId}`);
        connectedUsers.delete(userId);

        // Remove user from Firestore or mark as disconnected
        await usersCollection.doc(userId).update({
          isConnected: false,
          disconnectedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        break;
      }
    }
  });
});

// Test Firebase Connection
app.get("/api/test-firebase", async (req, res) => {
  try {
    // Test if we can write to Firestore
    const testRef = db.collection("testConnection").doc("ping");
    await testRef.set({
      message: "Firebase connection test",
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: "success",
    });

    // Test if we can read from Firestore
    const doc = await testRef.get();

    if (doc.exists) {
      res.json({
        success: true,
        message: "✅ Firebase connection is working!",
        data: doc.data(),
      });
    } else {
      res.status(500).json({
        success: false,
        message: "❌ Firebase write succeeded but read failed",
      });
    }
  } catch (error: any) {
    console.error("Firebase test error:", error);
    res.status(500).json({
      success: false,
      message: "❌ Firebase connection failed",
      error: error.message,
    });
  }
});

// ===========================================================
// 🚀 Start the server using your Wi-Fi IP address
// ===========================================================
const PORT = 3000;
const HOST = "192.168.100.68"; // 🛑 Replace this with your actual Wi-Fi IP

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
