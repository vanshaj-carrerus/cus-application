import { Schema, model, models, type Document, type Model } from "mongoose";
import { ROLES, type Role } from "./enums";

export interface IUser extends Document {
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  avatarUrl?: string;
  phone?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, default: "RECRUITER" },
    avatarUrl: String,
    phone: String,
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

UserSchema.index({ role: 1 });

export const User: Model<IUser> = models.User || model<IUser>("User", UserSchema);
