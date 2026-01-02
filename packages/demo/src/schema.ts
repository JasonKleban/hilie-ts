
import type { FieldSchema } from "hilie"

/**
 * Pre-built field schema for household information extraction.
 * Defines the fields (ExtID, Name, Phone, Email, etc.) with their repeatability constraints.
 */
export const householdInfoSchema: FieldSchema = {
  fields: [
    { name: 'ExtID', maxAllowed: 1 },
    { name: 'Name', maxAllowed: 2 },
    { name: 'PreferredName', maxAllowed: 1 },
    { name: 'Phone', maxAllowed: 3 },
    { name: 'Email', maxAllowed: 3 },
    { name: 'GeneralNotes', maxAllowed: 1 },
    { name: 'MedicalNotes', maxAllowed: 1 },
    { name: 'DietaryNotes', maxAllowed: 1 },
    { name: 'Birthdate', maxAllowed: 1 }
  ],
  noiseLabel: 'NOISE'
};