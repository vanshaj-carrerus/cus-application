import { config } from "dotenv";
config({ path: ".env.local" });
import { connectDB } from "@/lib/db/mongodb";
import { User } from "@/lib/models/User";
import { hashPassword } from "@/lib/auth/session";
import mongoose from "mongoose";

async function main() {
  await connectDB();

  const email = process.env.SEED_ADMIN_EMAIL || "admin@custech.co";
  const password = process.env.SEED_ADMIN_PASSWORD || "ChangeMe123!";

  const existing = await User.findOne({ email });
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
  } else {
    const passwordHash = await hashPassword(password);
    await User.create({ name: "Super Admin", email, passwordHash, role: "SUPER_ADMIN" });
    console.log(`Created SUPER_ADMIN user: ${email} / ${password}`);
    console.log("Change this password after first login.");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
