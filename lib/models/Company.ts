import { Schema, model, models, type Document, type Model } from "mongoose";

export interface ICompany extends Document {
  name: string;
  domain?: string;
  logoUrl?: string;
  industry?: string;
  size?: string;
  location?: string;
  description?: string;
  source?: string;
  externalCompanyId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CompanySchema = new Schema<ICompany>(
  {
    name: { type: String, required: true, trim: true },
    domain: { type: String, trim: true, lowercase: true },
    logoUrl: String,
    industry: String,
    size: String,
    location: String,
    description: String,
    source: String,
    externalCompanyId: String,
  },
  { timestamps: true }
);

CompanySchema.index({ name: 1 });
CompanySchema.index({ domain: 1 });

export const Company: Model<ICompany> = models.Company || model<ICompany>("Company", CompanySchema);
