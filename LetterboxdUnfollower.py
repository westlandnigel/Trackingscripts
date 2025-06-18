import sys
import time
from colorama import Fore, init

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, NoSuchElementException

# Initialize colorama
init(autoreset=True)

def printFormattedList(arg_list, amount_per_line):
	if not arg_list:
		print("None")
		return
	for i in range(0, len(arg_list), amount_per_line):
		names_to_print = arg_list[i: i + amount_per_line]
		print(*names_to_print, sep=", ")

def verifyURL():
	try:
		url = sys.argv[1]
	except IndexError:
		url = input("Please enter your Letterboxd user URL: ")
	if not url.endswith('/'):
		url += '/'
	if not url.startswith('https://letterboxd.com/'):
		input(Fore.RED + "Invalid address, must be a letterboxd.com URL. Terminating...")
		exit(-1)
	return url

def getAllUsers_selenium(driver, wait, base_url, follower_following):
	i = 1
	users_list = []
	print(f"Scraping {follower_following} list...")
	while True:
		page_url = f"{base_url}{follower_following}/page/{i}/"
		driver.get(page_url)
		try:
			wait.until(EC.presence_of_element_located((By.CLASS_NAME, "person-table")))
			user_elements = driver.find_elements(By.CSS_SELECTOR, ".person-table a.name")

			if not user_elements:
				print(f"Found all {follower_following}. Total: {len(users_list)}")
				break

			for element in user_elements:
				href = element.get_attribute("href")
				username = href.strip('/').split('/')[-1]
				users_list.append(username)
			
			i += 1
		except TimeoutException:
			print(f"Reached end of {follower_following} list. Total: {len(users_list)}")
			break
		except Exception as e:
			print(Fore.RED + f"An unexpected error occurred while scraping page {i}: {e}")
			break

	users_list.sort()
	return users_list

def unfollow_users(driver, wait, dont_follow_back):
	total_to_unfollow = len(dont_follow_back)
	print(f"\nStarting to unfollow {total_to_unfollow} users...")
	for index, username in enumerate(dont_follow_back, 1):
		print(f"[{index}/{total_to_unfollow}] Unfollowing {username}...")
		try:
			driver.get(f"https://letterboxd.com/{username}/")
			unfollow_button = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "a.js-button-following")))
			unfollow_button.click()
			time.sleep(0.5) 
		except TimeoutException:
			print(Fore.YELLOW + f"Could not find the 'Following' button for {username}. Maybe you already unfollowed them or they are a special account?")
		except Exception as e:
			print(Fore.RED + f"An error occurred while trying to unfollow {username}: {e}")

def verifyYesNo():
	character = input("\nDo you want to unfollow the users who don't follow you back? [Y/N] ")
	while character.lower() not in ['y', 'n']:
		character = input("Invalid input, please try again [Y/N]: ")
	return character.lower() == 'y'

def login_to_letterboxd(driver, wait):
	"""Prompts for credentials and logs into Letterboxd. Returns True on success, False on failure."""
	print("\nPlease log in to your Letterboxd account to proceed with unfollowing.")
	login_username = input("Enter your Letterboxd username or email: ")
	login_password = input("Enter your password: ")

	driver.get("https://letterboxd.com/sign-in/")
	try:
		# --- THIS IS THE FIX ---
		# The IDs for the input fields on the dedicated sign-in page are different.
		username_field = wait.until(EC.element_to_be_clickable((By.ID, "field-username")))
		password_field = wait.until(EC.element_to_be_clickable((By.ID, "field-password")))
		
		username_field.send_keys(login_username)
		password_field.send_keys(login_password)
		password_field.send_keys(Keys.RETURN)
		# This element ID is still a valid way to confirm a successful login.
		wait.until(EC.presence_of_element_located((By.ID, "add-new-button")))
		print(Fore.GREEN + "Login successful.")
		return True
	except TimeoutException:
		print(Fore.RED + "Login failed. Wrong username/password or captcha required. Aborting unfollow process.")
		return False
	except Exception as e:
		print(Fore.RED + f"An unexpected error occurred during login: {e}")
		return False


def main():
	url = verifyURL()
	username = url.strip('/').split('/')[-1]
	print(f"Analyzing account: {username}")
	
	options = Options()
	options.add_experimental_option('excludeSwitches', ['enable-logging'])
	options.add_argument('--blink-settings=imagesEnabled=false')
	# For debugging, comment out the line below to see the browser in action
	options.add_argument("--headless=new") 
	options.add_argument("--disable-gpu")
	options.page_load_strategy = 'eager'

	driver = webdriver.Chrome(options=options)
	wait = WebDriverWait(driver, 10)

	followers_list = getAllUsers_selenium(driver, wait, url, "followers")
	following_list = getAllUsers_selenium(driver, wait, url, "following")

	dont_follow_back = sorted(list(set(following_list) - set(followers_list)))
	not_following_back = sorted(list(set(followers_list) - set(following_list)))

	print("\n" + "="*30)
	print("ANALYSIS COMPLETE")
	print("="*30)

	print(Fore.RED + f"\nUsers who don't follow you back ({len(dont_follow_back)}):")
	printFormattedList(dont_follow_back, 10)

	print(Fore.GREEN + f"\nFans (users you don't follow back) ({len(not_following_back)}):")
	printFormattedList(not_following_back, 10)
	
	print(f"\nTotal Following: {len(following_list)}")
	print(f"Total Followers: {len(followers_list)}")

	if dont_follow_back and verifyYesNo():
		if login_to_letterboxd(driver, wait):
			unfollow_users(driver, wait, dont_follow_back)
			print(Fore.GREEN + "\nUnfollow process complete.")

	driver.quit()
	input("\nDone. Press Enter to exit.")


if __name__ == '__main__':
	main()