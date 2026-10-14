BEGIN TRY
    BEGIN TRAN
    UPDATE Accounts
    SET Balance = Balance - 100
    WHERE Id = 1
    UPDATE Accounts
    SET Balance = Balance + 100
    WHERE Id = 2
    COMMIT TRAN
END TRY
BEGIN CATCH
    IF @@trancount > 0
        ROLLBACK TRAN;
    THROW;
END CATCH
