// Shared with console validation and execution preflight.
const optionalPostcode = new Set(
  'AE AG AO AW BF BI BJ BO BQ BS BW BZ CD CF CG CI CK CM CW DJ DM ER FJ GD GH GM GN GQ GY HK KI KM KN KP LC LY ML MO MR NR NU QA RW SB SC SL SO SR ST SY TD TF TG TK TL TO TT TV TZ UG VU YE ZW'.split(
    ' ',
  ),
);
export const billingPostalCodeOptional = (country: string) => optionalPostcode.has(country);
