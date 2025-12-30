import fs from 'fs/promises';
import path from 'path';
/// <reference path="../../synthesized-data.d.ts" />

type PersonNode = 
  Omit<Person, "PersonID">
  & {
    guardians: { GuardianRole : Guardianship["GuardianRole"]; Person: PersonNode; }[]; 
    wards: { GuardianRole : Guardianship["GuardianRole"]; Person: PersonNode; }[]; 
  }

async function main() {
  const infile = process.argv[2] ?? path.join('src', 'tests', 'data', 'maryland_5th_graders_household_realistic.json');

  console.log(`Reading ${infile}...`);

  const raw = await fs.readFile(infile, 'utf8');
  const data : DataSet = JSON.parse(raw) as any;

  if (!Array.isArray(data.People)) throw new Error('Invalid input: expected People array');
  if (!Array.isArray(data.Guardianships)) throw new Error('Invalid input: expected Guardianships array');

  const peopleById = new Map<number, PersonNode>();

  for (const p of data.People) {
    if (typeof p.PersonID !== 'number') continue;

    peopleById.set(p.PersonID, {
      StudentID: p.StudentID,
      FirstName: p.FirstName,
      LastName: p.LastName,
      FullName: p.FullName,
      PreferredName: p.PreferredName,
      Phone: p.Phone,
      Email: p.Email,
      Languages: p.Languages,
      GeneralNotes: p.GeneralNotes,
      MedicalNotes: p.MedicalNotes,
      DietaryNotes: p.DietaryNotes,
      Birthdate: p.Birthdate,
      guardians: [],
      wards: []
    });
  }

  // Build per-person relations: each primary gets a 'guardians' list and each guardian gets 'wards'
  let convertedCount = 0;
  for (const g of data.Guardianships) {
    const primary = peopleById.get(g.PrimaryPersonID)!;
    const guardian = peopleById.get(g.GuardianPersonID)!;

    if (!primary) console.warn(`Warning: PrimaryPersonID ${g.PrimaryPersonID} not found`);
    if (!guardian) console.warn(`Warning: GuardianPersonID ${g.GuardianPersonID} not found`);

    if (primary) {
      primary.guardians.push({
        GuardianRole: g.GuardianRole,
        Person: guardian
      });
    }

    if (guardian) {
      guardian.wards.push({
        GuardianRole: g.GuardianRole,
        Person: primary
      });
    }

    convertedCount += 1;
  }
  
  return Array.from(peopleById.values().filter(p => p.wards.length === 0));
}

main()
.then(people => {

  // CASE 3

  for(let person of people) {
    const guardians = person.guardians.map(g => [
      g.Person.FullName,
      g.Person.PreferredName,
      g.Person.Phone?.join(';'),
      g.Person.Email?.join(';'),
      g.Person.Languages?.join(';'),
      g.Person.GeneralNotes?.replace(/\r?\n/g, '..'),
      g.Person.MedicalNotes?.replace(/\r?\n/g, '..'),
      g.Person.DietaryNotes?.replace(/\r?\n/g, '..')
    ].join('\t')).join('\t');

    const row = [
      person.StudentID,
      person.FullName,
      person.PreferredName,
      person.Phone?.join(';'),
      person.Email?.join(';'),
      person.Languages?.join(';'),
      person.GeneralNotes?.replace(/\r?\n/g, '..'),
      person.MedicalNotes?.replace(/\r?\n/g, '..'),
      person.DietaryNotes?.replace(/\r?\n/g, '..'),
      person.Birthdate,
      guardians
    ].join('\t');

    console.log(row);
  }

  console.log();
  console.log();
  console.log();

  // CASE 4

  for(let person of people) {

    const row = [
      person.StudentID,
      person.FullName,
      "",
      person.PreferredName,
      person.Phone?.join(';'),
      person.Email?.join(';'),
      person.Languages?.join(';'),
      person.GeneralNotes?.replace(/\r?\n/g, '..'),
      person.MedicalNotes?.replace(/\r?\n/g, '..'),
      person.DietaryNotes?.replace(/\r?\n/g, '..'),
      person.Birthdate
    ].join('\t');

    console.log(row);

    const guardians = person.guardians.map(g => [
      g.Person.FullName,
      g.Person.PreferredName,
      g.Person.Phone?.join(';'),
      g.Person.Email?.join(';'),
      g.Person.Languages?.join(';'),
      g.Person.GeneralNotes?.replace(/\r?\n/g, '..'),
      g.Person.MedicalNotes?.replace(/\r?\n/g, '..'),
      g.Person.DietaryNotes?.replace(/\r?\n/g, '..')
    ].join('\t'));

    for(let guardian of guardians) {
      console.log("\t\t" + guardian);
    }
  }

  console.log();
  console.log();
  console.log();

  // CASE 1

  for(let person of people) {

    console.log(person.PreferredName 
      ? `\n${person.FirstName} "${person.PreferredName}" ${person.FirstName} (${person.StudentID})`
      : `\n${person.FullName} (${person.StudentID})`);

    console.log('\t* ' + [
      person.Phone?.join('\n\t* '),
      person.Email?.join('\n\t* '),
      person.Languages?.join(', '),
      person.GeneralNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t'),
      person.MedicalNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t'),
      person.DietaryNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t'),
      person.Birthdate
    ].filter(Boolean).join('\n\t* '));

    for(let guardian of person.guardians) {
      console.log(guardian.Person.PreferredName 
        ? `\t* ${guardian.Person.FirstName} "${guardian.Person.PreferredName}" ${guardian.Person.FirstName} (${guardian.GuardianRole})`
        : `\t* ${guardian.Person.FullName} (${guardian.GuardianRole})`);

      console.log('\t\t* ' + [
        guardian.Person.Phone?.join('\n\t\t* '),
        guardian.Person.Email?.join('\n\t\t* '),
        guardian.Person.Languages?.join(', '),
        guardian.Person.GeneralNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t\t'),
        guardian.Person.MedicalNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t\t'),
        guardian.Person.DietaryNotes?.replace(/\r?\n$/g, '').replace(/\r?\n/g, '\n\t\t\t')
      ].filter(Boolean).join('\n\t\t* '));
    }
  }
})
.catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
