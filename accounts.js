import fs from "fs";
import chalk from "chalk";

function loadData(file) {
  try {
    const data = fs.readFileSync(file, "utf8").replace(/\r/g, "").split("\n").filter(Boolean);
    // Kiểm tra nếu không có dữ liệu
    if (data.length === 0) {
      console.log(chalk.yellow(`No data found in file ${file}`));
      return [];
    }
    return data;
  } catch (error) {
    console.log(chalk.red(`Error reading file ${file}: ${error.message}`));
    return [];
  }
}

export const accounts = (() => {
  const data = loadData("accounts.txt");
  return data.map((account) => {
    const [username, password] = account.split("|");
    return { username, password };
  });
})();
