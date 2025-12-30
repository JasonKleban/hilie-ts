interface Person {
  /** Required and unique positive integer among Person records */
  PersonID: number;
  /** Random numeric or alphanumeric identification string */
  StudentID?: string | undefined;
  FirstName: string;
  LastName: string;
  FullName: string;
  /** Populated only if different from FirstName. Age appropriate, possibly prefixed with a title for adults. */
  PreferredName?: string | undefined;
  /** Unlikely to be populated for young children, very likely for adults.  Multiple entries possible but unlikely. */
  Phone?: string[] | undefined;
    /** Unlikely to be populated for young children, very likely for adults.  Multiple entries possible but unlikely. */
  Email?: string[] | undefined;
  /** English names of languages spoken.  Often omitted when "English" is the only language spoken */
  Languages?: string[] | undefined;
  /** Markdown Formatted Multiline Notes, present in ~10% of records */
  GeneralNotes?: string | undefined;
  /** Markdown Formatted Multiline Notes, present in ~20% of records */
  MedicalNotes?: string | undefined;
  /** Markdown Formatted Multiline Notes, present in ~25% of records */
  DietaryNotes?: string | undefined;
  /** YYYY-MM-DD formatted birthdates */
  Birthdate?: string | undefined;
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