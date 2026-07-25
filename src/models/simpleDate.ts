export class SimpleDate {
    year?: number;
    month?: number;
    day?: number;
  
    constructor(year?: number, month?: number, day?: number) {
      if (year !== undefined) {
        this.validateYear(year);
        this.year = year;
      }
  
      if (month !== undefined) {
        this.validateMonth(month);
        this.month = month;
      }
  
      if (day !== undefined) {
        this.validateDay(day, month, year);
        this.day = day;
      }
    }
  
    private validateYear(year: number): void {
      if (year < 0) {
        throw new Error("Year must be a positive number");
      }
    }
  
    private validateMonth(month: number): void {
      if (month < 1 || month > 12) {
        throw new Error("Month must be between 1 and 12");
      }
    }
  
    private validateDay(day: number, month?: number, year?: number): void {
      if (day < 1 || day > 31) {
        throw new Error("Day must be between 1 and 31");
      }
      // Further validation for specific month/day combinations
      if (month !== undefined && year !== undefined) {
        const maxDays = new Date(year, month, 0).getDate(); // Get the last day of the month
        if (day > maxDays) {
          throw new Error(`Day must be between 1 and ${maxDays} for month ${month} in year ${year}`);
        }
      }
    }

    // Returns the date in the format "YYYY/MM/DD", remove the hyphens in between the year, month, and day when either side is not present
    toString(): string {
        let year = this.year ? this.year.toString() : "";
        let month = this.month ? this.month.toString() : "";
        let day = this.day ? this.day.toString() : "";
        return `${year}${year && month ? "/" : ""}${month}${(year || month) && day ? "/" : ""}${day}`;
    }

    // Create a SimpleDate object from a JSON object
    static fromJson(json: any): SimpleDate {
        return new SimpleDate(json.year, json.month, json.day);
    }
}