import { Schema, model, models, type Document, type Model, type Types } from "mongoose";

export interface IClient extends Document {
  name: string;
  companyId?: Types.ObjectId;
  primaryContactName?: string;
  primaryContactEmail?: string;
  primaryContactPhone?: string;
  accountManagerId?: Types.ObjectId;
  status: "ACTIVE" | "INACTIVE" | "PROSPECT";
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientSchema = new Schema<IClient>(
  {
    name: { type: String, required: true, trim: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company" },
    primaryContactName: String,
    primaryContactEmail: String,
    primaryContactPhone: String,
    accountManagerId: { type: Schema.Types.ObjectId, ref: "User" },
    status: { type: String, enum: ["ACTIVE", "INACTIVE", "PROSPECT"], default: "ACTIVE" },
    notes: String,
  },
  { timestamps: true }
);

ClientSchema.index({ name: 1 });
ClientSchema.index({ status: 1 });

export const Client: Model<IClient> = models.Client || model<IClient>("Client", ClientSchema);
