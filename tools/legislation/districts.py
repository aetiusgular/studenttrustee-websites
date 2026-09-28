"""
State legislatures in one place: chamber names, seat counts, what a county is called, and the
district-name normalization that joins the Census relationship files to Open States' legislators.

Seat counts are the fixed sizes of each chamber (NCSL); they let the site report vacancies.
District identifiers differ by source: the Census writes "014", "01A", "00A" (Alaska's lettered
senate seats) or names ("1st Barnstable District", "Addison-1 State House District",
"State House District Belknap 01"); Open States writes "14", "1A", "A", "1st Barnstable",
"Addison-1", "Belknap 1". key() reduces both to the same string.
"""
import re

# code: (name, fips, upper seats, lower seats); lower 0 = unicameral (Nebraska) or a council (DC)
STATES = {
    'AL': ('Alabama', '01', 35, 105), 'AK': ('Alaska', '02', 20, 40), 'AZ': ('Arizona', '04', 30, 60),
    'AR': ('Arkansas', '05', 35, 100), 'CA': ('California', '06', 40, 80), 'CO': ('Colorado', '08', 35, 65),
    'CT': ('Connecticut', '09', 36, 151), 'DE': ('Delaware', '10', 21, 41), 'DC': ('District of Columbia', '11', 13, 0),
    'FL': ('Florida', '12', 40, 120), 'GA': ('Georgia', '13', 56, 180), 'HI': ('Hawaii', '15', 25, 51),
    'ID': ('Idaho', '16', 35, 70), 'IL': ('Illinois', '17', 59, 118), 'IN': ('Indiana', '18', 50, 100),
    'IA': ('Iowa', '19', 50, 100), 'KS': ('Kansas', '20', 40, 125), 'KY': ('Kentucky', '21', 38, 100),
    'LA': ('Louisiana', '22', 39, 105), 'ME': ('Maine', '23', 35, 151), 'MD': ('Maryland', '24', 47, 141),
    'MA': ('Massachusetts', '25', 40, 160), 'MI': ('Michigan', '26', 38, 110), 'MN': ('Minnesota', '27', 67, 134),
    'MS': ('Mississippi', '28', 52, 122), 'MO': ('Missouri', '29', 34, 163), 'MT': ('Montana', '30', 50, 100),
    'NE': ('Nebraska', '31', 49, 0), 'NV': ('Nevada', '32', 21, 42), 'NH': ('New Hampshire', '33', 24, 400),
    'NJ': ('New Jersey', '34', 40, 80), 'NM': ('New Mexico', '35', 42, 70), 'NY': ('New York', '36', 63, 150),
    'NC': ('North Carolina', '37', 50, 120), 'ND': ('North Dakota', '38', 47, 94), 'OH': ('Ohio', '39', 33, 99),
    'OK': ('Oklahoma', '40', 48, 101), 'OR': ('Oregon', '41', 30, 60), 'PA': ('Pennsylvania', '42', 50, 203),
    'PR': ('Puerto Rico', '72', 27, 51), 'RI': ('Rhode Island', '44', 38, 75), 'SC': ('South Carolina', '45', 46, 124),
    'SD': ('South Dakota', '46', 35, 70), 'TN': ('Tennessee', '47', 33, 99), 'TX': ('Texas', '48', 31, 150),
    'UT': ('Utah', '49', 29, 75), 'VT': ('Vermont', '50', 30, 150), 'VA': ('Virginia', '51', 40, 100),
    'WA': ('Washington', '53', 49, 98), 'WV': ('West Virginia', '54', 34, 100), 'WI': ('Wisconsin', '55', 33, 99),
    'WY': ('Wyoming', '56', 31, 62),
}
BY_FIPS = {v[1]: k for k, v in STATES.items()}

LOWER_NAME = {'CA': 'Assembly', 'NY': 'Assembly', 'NV': 'Assembly', 'WI': 'Assembly', 'NJ': 'General Assembly',
              'MD': 'House of Delegates', 'VA': 'House of Delegates', 'WV': 'House of Delegates',
              'PR': 'House of Representatives'}
UPPER_NAME = {'NE': 'Legislature', 'DC': 'Council'}
LEGISLATURE_NAME = {'NE': 'Nebraska Legislature', 'DC': 'Council of the District of Columbia', 'PR': 'Legislative Assembly of Puerto Rico',
                    'CA': 'California Legislature'}

# What the state calls a county, and what a county's governing board is called where the name is the same statewide.
COUNTY_WORD = {'LA': 'parish', 'AK': 'borough or census area', 'PR': 'municipio', 'DC': 'district'}
BOARD_NAME = {'CA': 'Board of Supervisors', 'TX': 'Commissioners Court', 'AZ': 'Board of Supervisors', 'IA': 'Board of Supervisors',
              'MS': 'Board of Supervisors', 'NJ': 'Board of County Commissioners', 'DC': 'Council of the District of Columbia',
              'PR': 'Municipal Assembly'}
# States where counties have no government of their own.
NO_COUNTY_GOVERNMENT = {'CT': 'Connecticut abolished county government in 1960; towns and regional councils govern instead.',
                        'RI': 'Rhode Island has no county government; its 39 cities and towns govern locally.'}


def chamber_label(st, chamber):
    if chamber in ('legislature', 'upper') and st in UPPER_NAME:
        return UPPER_NAME[st]
    if chamber == 'upper':
        return 'Senate'
    return LOWER_NAME.get(st, 'House of Representatives')


def legislature_name(st):
    return LEGISLATURE_NAME.get(st) or '%s Legislature' % STATES[st][0]


_JUNK = re.compile(r'state legislative subdistrict|state legislative district|state house districts? not defined|state senate districts? not defined'
                   r'|state house district|state senate district|senatorial district|legislative district|district|ward')


def key(value):
    """Normalize a district code or name: '014' -> '14', '01A' -> '1a', '00A' -> 'a',
    'State House District Belknap 01' -> 'belknap 1', '1st Barnstable District' -> '1st barnstable',
    'Berkshire, Hampden, Franklin and Hampshire' -> 'berkshire hampden franklin hampshire'."""
    s = str(value or '').lower().strip()
    if re.fullmatch(r'0*[0-9]*[a-z]?', s) and s:
        return s.lstrip('0') or '0'
    s = _JUNK.sub(' ', s)
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    s = re.sub(r'\band\b', ' ', s)
    s = re.sub(r'\b0+(\d)', r'\1', s)
    return ' '.join(s.split())


_LABEL_JUNK = ('State House District', 'State Senate District', 'Senatorial District', 'State Legislative Subdistrict',
               'State Legislative District', 'District')


def label(code, name):
    """Readable district label: numbered districts keep the number ('14', '1A', 'A'); named districts
    keep the name without the boilerplate ('Addison-1', '1st Barnstable', 'Belknap 1')."""
    c = str(code or '').strip()
    if c and re.fullmatch(r'0*[0-9]*[A-Za-z]?', c) and not re.search(r'[A-Za-z]{2}', name or ''):
        return c.lstrip('0') or '0'
    words = name or c
    for junk in _LABEL_JUNK:
        words = words.replace(junk, ' ')
    words = re.sub(r'\b0+(\d)', r'\1', ' '.join(words.split()))
    return words.strip(' ,') or c
