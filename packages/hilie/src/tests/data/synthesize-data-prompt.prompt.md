
Please synthesize a downloadable JSON file that adheres to the following typescript schema, its commented requirements, and contains statistically plausible demographic data for at least seventy-five 5th graders currently attending public school in Maryland, USA.  Please be careful to ensure referential integrity within the dataset.  Please incorporate household-level realism such as shared guardians across siblings and various modern family arrangements like shared-custody in mixed families and same-sex couples.

```

interface Person {
  /** Required and unique positive integer among Person records */
  PersonID: number;
  /** Random numeric or alphanumeric identification string */
  StudentID?: string;
  FirstName: string;
  LastName: string;
  FullName: string;
  /** Populated only if different from FirstName. Age appropriate, possibly prefixed with a title for adults. */
  PreferredName?: string;
  /** Unlikely to be populated for young children, very likely for adults.  Multiple entries possible but unlikely. */
  Phone?: string[];
    /** Unlikely to be populated for young children, very likely for adults.  Multiple entries possible but unlikely. */
  Email?: string[];
  /** English names of languages spoken.  Often omitted when "English" is the only language spoken */
  Languages?: string[];
  /** Markdown Formatted Multiline Notes, present in ~10% of records */
  GeneralNotes?: string;
  /** Markdown Formatted Multiline Notes, present in ~20% of records */
  MedicalNotes?: string;
  /** Markdown Formatted Multiline Notes, present in ~25% of records */
  DietaryNotes?: string;
  /** YYYY-MM-DD formatted birthdates */
  Birthdate?: string;
}

/** Represents a guardianship relation between two Person records.  
 * The set of all Guardianships and their Persons should represent statistically plausible arrangements.
 * Each Person under 18 ought to have at least one Guardian */
interface Guardianship {
  /** references Person.PersonID of the Child Person record which is statistically appropriate for this relation */
  PrimaryPersonID: number;
  /** references Person.PersonID of the Guardian Person record which is statistically appropriate for this relation */
  GuardianPersonID: number;
  /** Adult Primaries are much more likely to only have "Emergency Contact" relations */
  GuardianRole: "Parent" | "Grandparent" | "Aunt/Uncle" | "Foster/Other Legal Guardian" | "Emergency Contact";
}

interface DataSet{
  People: Person[];
  Guardianships: Guardianship[];
}
```
