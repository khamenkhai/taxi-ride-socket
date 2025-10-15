// server.ts (updated)
// ===========================================================
// 🔧 Firestore-backed Socket.IO ride server
// ===========================================================

import express from "express";
import http from "http";
import { Server } from "socket.io";

import admin from "firebase-admin"; // 🔧 Firestore admin SDK

// ⚠️ Initialize Firebase Admin SDK - replace with your credentials or use environment default credentials
// 🔧 You can use a service account JSON or set GOOGLE_APPLICATION_CREDENTIALS env var.
try {
  admin.initializeApp({
    // credential: admin.credential.cert(require("./serviceAccountKey.json")),
    credential: admin.credential.applicationDefault(),
  });
} catch (e) {
  // already initialized in hot-reload environments
  // console.warn("Firebase admin init:", e);
}

const db = admin.firestore(); // 🔧 Firestore instance

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

// ✂️ Removed in-memory maps (we persist & query rides in Firestore)
// const activeRides = new Map<string, Ride>();
// const connectedUsers = new Map<string, User>();

interface User {
  id: string;
  type: "rider" | "driver";
  socketId: string;
}

io.on("connection", (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);

  // ===========================================================
  // ✅ User join and room management (no in-memory storage)
  // ===========================================================
  socket.on("user:join", (user: User) => {
    console.log(`👤 User joined:`, user);
    // 🔧 store minimal info on socket only
    socket.data.user = { id: user.id, type: user.type } as Omit<User, "socketId">;
    socket.join(user.id); // room by userId

    if (user.type === "driver") {
      socket.join("drivers");
      console.log(`🚗 Driver ${user.id} joined drivers room`);
    }
  });

  // ===========================================================
  // ✅ Rider requests a ride (now uses Firestore)
  // ===========================================================
  socket.on("ride:request", async (ride: Ride) => {
    console.log("📲 New ride request received:", ride);
    // 🔧 enforce one active ride per user
    try {
      const activeStatuses = ["requested", "accepted", "driverArrived", "inProgress"];
      const existingSnap = await db
        .collection("rides")
        .where("userId", "==", ride.userId)
        .where("status", "in", activeStatuses)
        .limit(1)
        .get();

      if (!existingSnap.empty) {
        console.log("❌ User already has an active ride:", ride.userId);
        socket.emit("ride:error", {
          code: "user_has_active_ride",
          message: "User already has an active ride.",
        });
        return;
      }

      ride.status = "requested";
      ride.createdAt = Date.now();

      // write ride to Firestore with rideId as doc id
      await db.collection("rides").doc(ride.rideId).set(ride);

      console.log("📡 Broadcasting to drivers 🚘:", ride);
      socket.to("drivers").emit("ride:requested", ride);
    } catch (err) {
      console.error("ride:request error", err);
      socket.emit("ride:error", { code: "internal_error", message: String(err) });
    }
  });

  // ===========================================================
  // ✅ Driver accepts ride (Firestore transaction + checks)
  // ===========================================================
  socket.on("ride:accept", async (ride: Ride) => {
    console.log("✅ Ride accepted by driver:", ride);
    const rideRef = db.collection("rides").doc(ride.rideId);

    try {
      await db.runTransaction(async (tx) => {
        const rideSnap = await tx.get(rideRef);
        if (!rideSnap.exists) {
          console.log("❌ Ride not found:", ride.rideId);
          socket.emit("ride:error", { code: "ride_not_found" });
          return;
        }

        const existingRide = rideSnap.data() as Ride;
        // If the ride is already taken or finished, abort
        if (
          existingRide.status === "accepted" ||
          existingRide.status === "driverArrived" ||
          existingRide.status === "inProgress" ||
          existingRide.status === "completed" ||
          existingRide.status === "cancelled"
        ) {
          console.log("❌ Ride already in progress or finished:", existingRide.status);
          socket.emit("ride:error", { code: "ride_unavailable", message: "Ride unavailable." });
          return;
        }

        // 🔧 Enforce driver doesn't have another active ride
        const driverActiveSnap = await db
          .collection("rides")
          .where("driverId", "==", ride.driverId)
          .where(
            "status",
            "in",
            ["requested", "accepted", "driverArrived", "inProgress"]
          )
          .limit(1)
          .get();

        if (!driverActiveSnap.empty) {
          console.log("❌ Driver already has an active ride:", ride.driverId);
          socket.emit("ride:error", {
            code: "driver_has_active_ride",
            message: "Driver already has an active ride.",
          });
          return;
        }

        // 🔧 Also ensure user still doesn't have another active ride (race safety)
        const userActiveSnap = await db
          .collection("rides")
          .where("userId", "==", existingRide.userId)
          .where(
            "status",
            "in",
            ["requested", "accepted", "driverArrived", "inProgress"]
          )
          .get();

        // userActiveSnap may include the same ride document itself; ensure it's OK
        const otherActive = userActiveSnap.docs.some(
          (d) => d.id !== ride.rideId
        );
        if (otherActive) {
          console.log("❌ User has another active ride:", existingRide.userId);
          socket.emit("ride:error", {
            code: "user_has_other_active_ride",
            message: "User has another active ride.",
          });
          return;
        }

        // update ride doc => accepted
        const updated: Partial<Ride> = {
          status: "accepted",
          driverId: ride.driverId,
        };
        tx.update(rideRef, updated);
      }); // end transaction

      // after success, read updated ride and emit
      const updatedSnap = await rideRef.get();
      if (!updatedSnap.exists) return;
      const updatedRide = updatedSnap.data() as Ride;

      console.log("📤 Sending ride:accepted to rider and driver:", updatedRide);
      io.to(updatedRide.userId).emit("ride:accepted", updatedRide);
      if (ride.driverId) io.to(ride.driverId).emit("ride:accepted", updatedRide);
    } catch (err) {
      console.error("ride:accept error:", err);
      socket.emit("ride:error", { code: "internal_error", message: String(err) });
    }
  });

  // ===========================================================
  // ✅ Driver arrived
  // ===========================================================
  socket.on("ride:driverArrived", async (data: { rideId: string }) => {
    console.log("📍 Driver arrived for ride:", data);
    const rideRef = db.collection("rides").doc(data.rideId);
    try {
      const rideSnap = await rideRef.get();
      if (!rideSnap.exists) return;
      const ride = rideSnap.data() as Ride;

      if (ride && (ride.status === "accepted" || ride.status === "driverArrived")) {
        await rideRef.update({ status: "driverArrived" });
        const updated = { ...ride, status: "driverArrived" };
        console.log("📤 Notifying rider driver has arrived:", updated);
        io.to(ride.userId).emit("ride:update", updated);
        if (ride.driverId) io.to(ride.driverId).emit("ride:update", updated);
      }
    } catch (err) {
      console.error("ride:driverArrived error", err);
    }
  });

  // ===========================================================
  // ✅ Driver starts the ride (In Progress)
  // ===========================================================
  socket.on("ride:inProgress", async (data: { rideId: string }) => {
    console.log("🚦 Ride in progress:", data);
    const rideRef = db.collection("rides").doc(data.rideId);

    try {
      const rideSnap = await rideRef.get();
      if (!rideSnap.exists) return;
      const ride = rideSnap.data() as Ride;

      if (ride && (ride.status === "driverArrived" || ride.status === "accepted")) {
        await rideRef.update({ status: "inProgress" });
        const updated = { ...ride, status: "inProgress" };
        console.log("📤 Updating rider and driver ride status:", updated);
        io.to(ride.userId).emit("ride:update", updated);
        if (ride.driverId) io.to(ride.driverId).emit("ride:update", updated);
      }
    } catch (err) {
      console.error("ride:inProgress error", err);
    }
  });

  // ===========================================================
  // ✅ Ride complete
  // ===========================================================
  socket.on("ride:complete", async (rideId: string) => {
    console.log("🏁 Ride completed:", rideId);
    const rideRef = db.collection("rides").doc(rideId);
    try {
      const rideSnap = await rideRef.get();
      if (!rideSnap.exists) return;
      const ride = rideSnap.data() as Ride;

      await rideRef.update({ status: "completed" });

      const updated = { ...ride, status: "completed" };
      console.log("📤 Notifying both parties of completion:", updated);
      io.to(ride.userId).emit("ride:update", updated);
      if (ride.driverId) io.to(ride.driverId).emit("ride:update", updated);

      // note: not deleting doc — keep for history. If you must remove, uncomment:
      // await rideRef.delete();
    } catch (err) {
      console.error("ride:complete error", err);
    }
  });

  // ===========================================================
  // ✅ Ride cancel
  // ===========================================================
  socket.on("ride:cancel", async (data: { rideId: string; reason?: string }) => {
    console.log("🚫 Ride cancelled:", data);
    const rideRef = db.collection("rides").doc(data.rideId);
    try {
      const rideSnap = await rideRef.get();
      if (!rideSnap.exists) return;
      const ride = rideSnap.data() as Ride;

      await rideRef.update({ status: "cancelled" });

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

      // note: not deleting doc — keep for history
    } catch (err) {
      console.error("ride:cancel error", err);
    }
  });

  // ===========================================================
  // 🔁 Auto Sync when user restarts app
  // ===========================================================
  socket.on("user:resync", async (userId: string) => {
    console.log(`🔄 Resync requested by ${userId}`);
    // 🔧 rejoin user's room in case socket was recreated
    socket.join(userId);
    // if driver, rejoin drivers room if their socket stored user info says so
    if (socket.data.user && socket.data.user.type === "driver") {
      socket.join("drivers");
    }

    try {
      const activeStatuses = ["requested", "accepted", "driverArrived", "inProgress"];
      const ridesSnap = await db
        .collection("rides")
        .where("status", "in", activeStatuses)
        .where("userId", "==", userId)
        .get();

      // also include rides where user is driver
      const driverSnap = await db
        .collection("rides")
        .where("status", "in", activeStatuses)
        .where("driverId", "==", userId)
        .get();

      const rides: Ride[] = [];
      ridesSnap.forEach((d) => rides.push(d.data() as Ride));
      driverSnap.forEach((d) => rides.push(d.data() as Ride));

      console.log("📤 Sending active rides on resync:", rides);
      if (rides.length > 0) {
        socket.emit("rides:resync", rides);
      }
    } catch (err) {
      console.error("user:resync error", err);
    }
  });

  // ===========================================================
  // 📡 Driver Location Update (Realtime tracking) -> Firestore update + emit to rider
  // ===========================================================
  socket.on(
    "driver:locationUpdate",
    async (data: { driverId: string; location: Location }) => {
      console.log("📍 Driver location update:", data);
      try {
        // find active ride(s) for this driver (should be 0 or 1 due to checks)
        const activeStatuses = ["requested", "accepted", "driverArrived", "inProgress"];
        const q = await db
          .collection("rides")
          .where("driverId", "==", data.driverId)
          .where("status", "in", activeStatuses)
          .get();

        if (q.empty) return;

        // Update driverLocation for each active ride (usually 1)
        for (const doc of q.docs) {
          const ride = doc.data() as Ride;
          await doc.ref.update({ driverLocation: data.location });

          console.log("📤 Sending location to rider:", {
            driverId: data.driverId,
            location: data.location,
          });

          io.to(ride.userId).emit("ride:driverLocation", {
            driverId: data.driverId,
            location: data.location,
          });
        }
      } catch (err) {
        console.error("driver:locationUpdate error", err);
      }
    }
  );

  // ===========================================================
  // ✅ Disconnect cleanup (no in-memory cleanup)
  // ===========================================================
  socket.on("disconnect", () => {
    console.log(`❌ User disconnected: ${socket.id}`);
    // ✂️ We no longer keep connectedUsers in-memory, so nothing to remove.
    // If you want to notify others you could emit a presence update here.
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
