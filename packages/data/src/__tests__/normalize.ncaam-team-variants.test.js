const { resolveTeamVariant } = require('../normalize');

describe('ncaam team variant mapping', () => {
  const cases = [
    ['George Mason Patriots', 'GEORGE MASON PATRIOTS'],
    ['Liberty Flames', 'LIBERTY FLAMES'],
    ['Howard Bison', 'HOWARD BISON'],
    ['Yale Bulldogs', 'YALE BULLDOGS'],
    ['UNC Wilmington Seahawks', 'UNC WILMINGTON SEAHAWKS'],
    ['Tulsa Golden Hurricane', 'TULSA GOLDEN HURRICANE'],
    ['Stephen F. Austin Lumberjacks', 'STEPHEN F. AUSTIN LUMBERJACKS'],
    ['NC State Wolfpack', 'NC STATE WOLFPACK'],
    ['South Alabama Jaguars', 'SOUTH ALABAMA JAGUARS'],
    ['Seattle Redhawks', 'SEATTLE REDHAWKS'],
    ['Seattle U Redhawks', 'SEATTLE REDHAWKS'],
    ['St. Thomas (MN) Tommies', 'ST. THOMAS (MN) TOMMIES'],
    ['St. Thomas-Minnesota Tommies', 'ST. THOMAS (MN) TOMMIES'],
    ['Saint Thomas Minnesota Tommies', 'ST. THOMAS (MN) TOMMIES'],
    ['UC Irvine Anteaters', 'UC IRVINE ANTEATERS'],
    ['Kennesaw St Owls', 'KENNESAW ST OWLS'],
    ['Dayton Flyers', 'DAYTON FLYERS'],
    ['North Carolina Tar Heels', 'NORTH CAROLINA TAR HEELS'],
    ['Duke Blue Devils', 'DUKE BLUE DEVILS'],
    ['St. John\'s Red Storm', 'ST. JOHN\'S RED STORM'],
    ['Michigan St Spartans', 'MICHIGAN ST SPARTANS'],
    ['North Dakota St Bison', 'NORTH DAKOTA ST BISON'],
    ['Murray St Racers', 'MURRAY ST RACERS'],
    ['Sam Houston St Bearkats', 'SAM HOUSTON ST BEARKATS'],
    ['UCF Knights', 'UCF KNIGHTS'],
    ['Queens University Royals', 'QUEENS UNIVERSITY ROYALS'],
    ['Missouri Tigers', 'MISSOURI TIGERS'],
    ['Long Island University Sharks', 'LIU SHARKS'],
    ['Prairie View A&M Panthers', 'PRAIRIE VIEW A&M PANTHERS'],
    ['California Baptist Lancers', 'CAL BAPTIST LANCERS'],
    ['Miami Ohio RedHawks', 'MIAMI (OH) REDHAWKS'],
  ];

  test.each(cases)('%s resolves to %s', (input, canonical) => {
    const result = resolveTeamVariant(input, 'normalize.ncaam-team-variants.test');
    expect(result.matched).toBe(true);
    expect(result.canonical).toBe(canonical);
  });
});
