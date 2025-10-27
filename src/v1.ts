import express from "express";
import http from "http";
import { Server } from "socket.io";
import admin from "firebase-admin";

// Initialize Firebase Admin
const serviceAccount : any = {
  "type": "service_account",
  "project_id": "project2-f5cb2",
  "private_key_id": "40db8b59f8965f04c080f0b83c5579ff195b6432",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbyM3hTNpUpov4\nP1V3zZuIqNGdgFxGXBKjArSecdrEo0hCxcxToOST7ZKT7QRKnuKigzGzD8ko26Zg\ni8eHIqwCJLI/3/YfrxRR7n6MkO+TUAAAvUvxN/xTEO9ZxsRpbrsD2MVA+p/nXLVN\nsdAZsH8PNoGY9PhdbEA0M2NEyB1DOvo6a04fgWmOr1CmEg9NDM1fUii5T4ilwJV0\nSGEane0dJXA0T7eT0dijGkFhd0TDg0szGOW1+bVOdv0AdKavZ1DJIMbbbZVfZRIi\n0MtO7w0HCmwCMms3Bg71nQK/7jyoP/AfNhf4Gmu4gqSGqR0SxrP/e8Y4pKMVaE4z\n7wYXYHynAgMBAAECggEAAcu9T9kWdT5cQ7bbMd/daKRlkja+GZOLJXTtBxyR5I1r\nUlW8ZsRmjiwBchIb6A5P14bCpmlKrN1nXBqQaMbmC7pHkcPvrurSRaWFsPIkyOJ1\ntYx5GSVHk9+QmszXS83aew9fKsIY4M5pSqV/nCQ0OsUqlkxQpqcOUGu9O7hA2hsJ\n124glOIotBOHF68G48r31F7+uqEzMIjsvAFB5vD8ZhRY6+pbsy/p09vE6cUWzK05\nLfyUOPkaDWHN/kQyMCKLalX0rLFzpcSYXHw1jgqNm5z0tKNuUMdhaDTsy2NlesVy\nPEZiQGiqVmt+TaONnyZCPfGz3Ra5DkeoOGqXf24pDQKBgQDMLL+ncgId7MNxXddy\nPXiJrc8l0yg0g+YjdALoKiWmT+3TcJXbYedZRJj7itfKpqzdALWH1X0Ug6BCbUCc\nK0rs3NAHLstvRwO2aQrAoyrXrtF6tzJZzRcEd/D8eHz1aA8mpTUKp3ITZs0D8bfV\nNfXL1VhuioO422m7j+4Qmu0uGwKBgQDDU6c9+E0dzujvTkmq2GUffbo1rx1k018D\nZBCkwLrqGrrqcPPDnPQmVE6F3hOtsm5z4tculwQorRGPr8WXiMalBcXRPnb/5nzC\n4LeghsucznV9CTennzxnpQkJuxg0uggfeBmcCl/q15ylc0aVDSR4Rp6/m6HMPM1w\nj7yKZwykZQKBgGgG2LNIzDlQ+5dUN8Q1+6cyTlu4RUDUfzpLDnwZlUsyaDsVntTD\nAiuiXsuyxxWybFrB1LvbkzoTgmC153hqOmeKbddrCS2uIf8bb+YMfHSd1o9OrbHB\nY9vb/IW2IfyrQyTugaLnA6FM/GHpEz/nmU98aO0RV+GksS9mOuZs+TFHAoGAW3Zw\nebQraCnbKTOfi0CJGZXl+/1j5jKT6yKQKJWW8MhTfjQl8RMtwET5//VdgZhr4Bf4\naviMGf/wmTfVbn+9hMiPOMvnLSzgfuB7G9ACyAplOYd3aCZIQsAk20mgrA/wfcvf\nMhIpl+4ei9rO0jy1NxzaeR6HRPuzt2GXB7f5U4ECgYA84PFLUJsC/htXxIwvus7C\nusg9nzHjr98eBpi5HYQsOQ4xm+9ZIV2jJPDYJH0vSMyLZw1sflRpqEIpmF5F7erF\nrwZugbcLa9dbJymRR9OFY/U6GX90atb+N3xKNzEEAMSOxX4BPYHQd1aqAvRhu+3e\nfZyWbf2nqTA1zzfvrRMo4A==\n-----END PRIVATE KEY-----\n",
  "client_email": "project2-service-account@project2-f5cb2.iam.gserviceaccount.com",
  "client_id": "101614200308291357992",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/project2-service-account%40project2-f5cb2.iam.gserviceaccount.com",
  "universe_domain": "googleapis.com"
}

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

    const existingRide = rideDoc.data() as Ride; // <-- make sure this line exists
    existingRide.status = "accepted";
    existingRide.driverId = ride.driverId;
    existingRide.driverLocation = ride.driverLocation;

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
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`🚀 Server is running at http://${HOST}:${PORT}`);
});
